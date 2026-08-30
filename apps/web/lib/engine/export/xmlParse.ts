// A small strict XML reader for the export tests and the Bambu round-trip
// check: elements, attributes, text, comments, processing instructions and the
// five predefined entities plus numeric character references. It throws on a
// mismatched or unclosed tag, an unterminated attribute or an unknown entity,
// which is exactly the well-formedness the tests want to assert. It is not a
// general parser (no DTD, no CDATA, no namespaces beyond keeping the prefix
// in the name) and is never used by an exporter.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text content, entities decoded. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(parseInt(body.slice(1), 10));
    }
    const named = ENTITIES[body];
    if (named === undefined) {
      throw new Error(`unknown entity ${whole}`);
    }
    return named;
  });
}

const NAME_RE = /^[A-Za-z_:][A-Za-z0-9_:.-]*/;

export function parseXml(source: string): XmlElement {
  let pos = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  // The explicit annotation is what lets control flow treat a `fail()` call as
  // terminating (TypeScript only narrows on never-returning calls to a
  // declared function type).
  const fail: (message: string) => never = (message) => {
    throw new Error(`xml: ${message} at offset ${pos}`);
  };

  const appendText = (text: string): void => {
    if (stack.length === 0) {
      if (text.trim() !== "") {
        fail("text outside the root element");
      }
      return;
    }
    stack[stack.length - 1].text += decodeEntities(text);
  };

  while (pos < source.length) {
    const lt = source.indexOf("<", pos);
    if (lt < 0) {
      appendText(source.slice(pos));
      pos = source.length;
      break;
    }
    if (lt > pos) {
      appendText(source.slice(pos, lt));
    }
    pos = lt;
    if (source.startsWith("<?", pos)) {
      const end = source.indexOf("?>", pos);
      if (end < 0) fail("unterminated processing instruction");
      pos = end + 2;
      continue;
    }
    if (source.startsWith("<!--", pos)) {
      const end = source.indexOf("-->", pos);
      if (end < 0) fail("unterminated comment");
      pos = end + 3;
      continue;
    }
    if (source.startsWith("<!", pos)) {
      fail("DTD or CDATA sections are not accepted");
    }
    if (source.startsWith("</", pos)) {
      pos += 2;
      const match = NAME_RE.exec(source.slice(pos));
      if (!match) fail("bad closing tag");
      const name = match[0];
      pos += name.length;
      while (pos < source.length && /\s/.test(source[pos])) pos += 1;
      if (source[pos] !== ">") fail("closing tag not terminated");
      pos += 1;
      const open = stack.pop();
      if (!open || open.name !== name) {
        fail(`closing </${name}> does not match <${open ? open.name : "nothing"}>`);
      }
      continue;
    }
    pos += 1;
    const match = NAME_RE.exec(source.slice(pos));
    if (!match) fail("bad opening tag");
    const element: XmlElement = { name: match[0], attributes: {}, children: [], text: "" };
    pos += element.name.length;
    let selfClosing = false;
    for (;;) {
      while (pos < source.length && /\s/.test(source[pos])) pos += 1;
      if (pos >= source.length) fail("unterminated opening tag");
      if (source.startsWith("/>", pos)) {
        selfClosing = true;
        pos += 2;
        break;
      }
      if (source[pos] === ">") {
        pos += 1;
        break;
      }
      const attr = NAME_RE.exec(source.slice(pos));
      if (!attr) fail("bad attribute name");
      const attrName = attr[0];
      pos += attrName.length;
      while (pos < source.length && /\s/.test(source[pos])) pos += 1;
      if (source[pos] !== "=") fail(`attribute ${attrName} has no value`);
      pos += 1;
      while (pos < source.length && /\s/.test(source[pos])) pos += 1;
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") fail(`attribute ${attrName} is not quoted`);
      const end = source.indexOf(quote, pos + 1);
      if (end < 0) fail(`attribute ${attrName} is unterminated`);
      const raw = source.slice(pos + 1, end);
      if (raw.indexOf("<") >= 0) fail(`attribute ${attrName} contains '<'`);
      if (attrName in element.attributes) fail(`duplicate attribute ${attrName}`);
      element.attributes[attrName] = decodeEntities(raw);
      pos = end + 1;
    }
    if (stack.length === 0) {
      if (root !== null) fail("more than one root element");
      root = element;
    } else {
      stack[stack.length - 1].children.push(element);
    }
    if (!selfClosing) {
      stack.push(element);
    }
  }
  if (stack.length > 0) {
    fail(`unclosed <${stack[stack.length - 1].name}>`);
  }
  if (root === null) {
    fail("no root element");
  }
  return root as XmlElement;
}

/** Every element in document order whose name equals `name`. */
export function findAll(node: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (el: XmlElement): void => {
    if (el.name === name) out.push(el);
    for (const child of el.children) walk(child);
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlElement, name: string): XmlElement | undefined {
  return findAll(node, name)[0];
}
