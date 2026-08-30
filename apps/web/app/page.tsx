import EditorShell from "@/components/editor/EditorShell";

/**
 * `/` is the whole product (01: "Land on `/`"). The page itself is a server
 * component; every interactive part lives under `EditorShell`, which is a
 * client component because the editor is one big piece of shared state.
 */
export default function Home() {
  return <EditorShell />;
}
