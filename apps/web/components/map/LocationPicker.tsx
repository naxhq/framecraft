"use client";

import { useEffect, useRef } from "react";
import {
  AttributionControl,
  type GeoJSONSource,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  circleRing,
  cropSquareRing,
  distanceM,
  polygonFeature,
  radiusHandlePosition,
  snapRadius,
} from "@/lib/geo";
import { useEditorStore } from "@/store/editor";
import { readMapPalette } from "./palette";

/**
 * The 2D location picker.
 *
 * OSM raster tiles only (03: Google / Apple / Bing are forbidden anywhere in
 * this product, not even for preview imagery). The tile server needs a real
 * referer and user agent, which a browser sends for us; this component is
 * loaded client-side only (see `MapPane.tsx`) so no server-side request ever
 * reaches tile.openstreetmap.org.
 *
 * Three interactions:
 *  - click the map to drop the pin,
 *  - drag the pin,
 *  - drag the handle on the circle to set the radius (250..3000 m, 10 m steps).
 *
 * Two overlays: the radius circle, and the *rotated crop square*, which is what
 * will actually be printed -- so the rotation slider has a visible meaning
 * before the user ever hits Generate.
 */

const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/**
 * maplibre-gl resolves its web worker with
 * `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Next's bundler
 * rewrites `import.meta.url` to the document URL, so that request lands on the
 * app's 404 HTML, the module worker fails to parse, and it dies SILENTLY: no
 * error event, raster tiles still fine, and every GeoJSON source stays empty
 * forever (which is exactly how the radius circle and the crop square went
 * missing). `scripts/copy-maplibre-worker.mjs` puts the real worker under
 * /public on predev/prebuild; this points maplibre at it.
 *
 * Module scope is safe: this file is only ever imported client-side, behind
 * `MapPane.tsx`'s `dynamic(..., { ssr: false })`.
 */
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
const CIRCLE_SOURCE = "framecraft-radius";
const CROP_SOURCE = "framecraft-crop";

export function LocationPicker() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const pinRef = useRef<Marker | null>(null);
  const handleRef = useRef<Marker | null>(null);
  const readyRef = useRef(false);
  const lastPresetRef = useRef<string | null>(null);

  const lat = useEditorStore((state) => state.location.lat);
  const lon = useEditorStore((state) => state.location.lon);
  const radiusM = useEditorStore((state) => state.location.radius_m);
  const rotationDeg = useEditorStore((state) => state.location.rotation_deg);
  const presetId = useEditorStore((state) => state.location.preset_id);

  // --- create the map once -------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    // Overlay ink from the design tokens; see components/map/palette.ts.
    const ink = readMapPalette();

    const map = new MapLibreMap({
      container,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            maxzoom: 19,
            attribution: OSM_ATTRIBUTION,
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [useEditorStore.getState().location.lon, useEditorStore.getState().location.lat],
      zoom: 13,
    });
    mapRef.current = map;

    map.on("error", (event) => {
      // Tile 404s and style problems must not be swallowed: a silent map is
      // indistinguishable from a broken one.
      console.warn("[framecraft] map error:", event.error?.message ?? event);
    });
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    const pinElement = document.createElement("div");
    pinElement.className = "framecraft-pin";
    pinElement.setAttribute("data-testid", "map-pin");
    pinElement.style.cssText = "width:18px;height:18px;border-radius:50%";
    pinElement.style.background = ink.pin;
    pinElement.style.border = `3px solid ${ink.pinRing}`;
    pinElement.style.boxShadow = ink.markerShadow;
    const pin = new Marker({ element: pinElement, draggable: true });
    pinRef.current = pin;

    const handleElement = document.createElement("div");
    handleElement.className = "framecraft-radius-handle";
    handleElement.setAttribute("data-testid", "map-radius-handle");
    handleElement.title = "Drag to change the radius";
    handleElement.style.cssText = "width:14px;height:14px;border-radius:3px";
    handleElement.style.background = ink.pinRing;
    handleElement.style.border = `2px solid ${ink.pin}`;
    handleElement.style.boxShadow = ink.markerShadow;
    const handle = new Marker({ element: handleElement, draggable: true });
    handleRef.current = handle;

    map.on("load", () => {
      const state = useEditorStore.getState().location;
      map.addSource(CIRCLE_SOURCE, {
        type: "geojson",
        data: polygonFeature(circleRing({ lat: state.lat, lon: state.lon }, state.radius_m)),
      });
      map.addLayer({
        id: `${CIRCLE_SOURCE}-fill`,
        type: "fill",
        source: CIRCLE_SOURCE,
        paint: { "fill-color": ink.radiusFill, "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: `${CIRCLE_SOURCE}-line`,
        type: "line",
        source: CIRCLE_SOURCE,
        paint: { "line-color": ink.radiusLine, "line-width": 1.5 },
      });

      map.addSource(CROP_SOURCE, {
        type: "geojson",
        data: polygonFeature(
          cropSquareRing(
            { lat: state.lat, lon: state.lon },
            state.radius_m,
            state.rotation_deg,
          ),
        ),
      });
      map.addLayer({
        id: `${CROP_SOURCE}-line`,
        type: "line",
        source: CROP_SOURCE,
        paint: {
          "line-color": ink.crop,
          "line-width": 2,
          "line-dasharray": [2, 1.5],
        },
      });

      pin.setLngLat([state.lon, state.lat]).addTo(map);
      const handlePoint = radiusHandlePosition(
        { lat: state.lat, lon: state.lon },
        state.radius_m,
      );
      handle.setLngLat([handlePoint.lon, handlePoint.lat]).addTo(map);
      readyRef.current = true;
    });

    map.on("click", (event) => {
      useEditorStore.getState().setPin(event.lngLat.lat, event.lngLat.lng);
    });

    pin.on("dragend", () => {
      const position = pin.getLngLat();
      useEditorStore.getState().setPin(position.lat, position.lng);
    });

    const applyHandle = (): void => {
      const centre = useEditorStore.getState().location;
      const position = handle.getLngLat();
      const metres = distanceM(
        { lat: centre.lat, lon: centre.lon },
        { lat: position.lat, lon: position.lng },
      );
      useEditorStore.getState().setRadius(snapRadius(metres));
    };
    handle.on("drag", applyHandle);
    handle.on("dragend", () => {
      applyHandle();
      // Radius is a server-side crop, so a committed change refetches /scene.
      void useEditorStore.getState().generate();
    });

    return () => {
      readyRef.current = false;
      pin.remove();
      handle.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // --- keep the overlays in sync with the store ----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const centre = { lat, lon };

    const circle = map.getSource(CIRCLE_SOURCE) as GeoJSONSource | undefined;
    circle?.setData(polygonFeature(circleRing(centre, radiusM)));
    const crop = map.getSource(CROP_SOURCE) as GeoJSONSource | undefined;
    crop?.setData(polygonFeature(cropSquareRing(centre, radiusM, rotationDeg)));

    pinRef.current?.setLngLat([lon, lat]);
    const handlePoint = radiusHandlePosition(centre, radiusM);
    handleRef.current?.setLngLat([handlePoint.lon, handlePoint.lat]);
  }, [lat, lon, radiusM, rotationDeg]);

  // --- fly to a newly selected preset --------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !presetId || presetId === lastPresetRef.current) return;
    lastPresetRef.current = presetId;
    const ring = circleRing({ lat, lon }, radiusM, 16);
    const bounds = ring.reduce(
      (accumulator, position) => accumulator.extend(position),
      new LngLatBounds(ring[0], ring[0]),
    );
    map.fitBounds(bounds, { padding: 40, duration: 900 });
  }, [presetId, lat, lon, radiusM]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="map" />
      <p
        data-testid="map-hint"
        className="pointer-events-none absolute left-2 top-2 max-w-[92%] rounded-milled border border-line bg-plate/95 px-2 py-1 text-2xs leading-snug text-ink-muted shadow-raised"
      >
        Click to move the pin · drag the square handle to set the radius. The
        dashed square is what gets printed.
      </p>
    </div>
  );
}

export default LocationPicker;
