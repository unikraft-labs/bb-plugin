export const MACHINE_LINE_PREFIX = "Unikraft Cloud sandbox ";
export const MACHINE_LINE_PATTERN = /^Unikraft Cloud sandbox (bbx-[a-z0-9-]+)$/u;
export const DECORATED_ATTRIBUTE = "data-ukc-decorated";
export const LINK_ATTRIBUTE = "data-ukc-console";

const SHOW_TEXT = 0x4;

export type ConsoleUrlLookup = (name: string) => string | null;

export function sandboxNameFrom(text: string): string | null {
  return MACHINE_LINE_PATTERN.exec(text.trim())?.[1] ?? null;
}

function renderedUrl(element: Element): string | null {
  return (
    element
      .querySelector(`a[${LINK_ATTRIBUTE}]`)
      ?.getAttribute("href") ?? null
  );
}

function render(element: Element, name: string, url: string | null): void {
  const document = element.ownerDocument;
  let label: HTMLElement;
  if (url === null) {
    label = document.createElement("span");
    label.className = "font-mono";
  } else {
    const link = document.createElement("a");
    link.setAttribute(LINK_ATTRIBUTE, "");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className =
      "font-mono underline underline-offset-2 hover:text-foreground";
    label = link;
  }
  label.textContent = name;
  element.setAttribute(DECORATED_ATTRIBUTE, name);
  element.replaceChildren(
    document.createTextNode("Unikraft Cloud ("),
    label,
    document.createTextNode(")"),
  );
}

export function decorateElement(
  element: Element,
  urlFor: ConsoleUrlLookup,
): boolean {
  const plain = sandboxNameFrom(element.textContent ?? "");
  const name = plain ?? element.getAttribute(DECORATED_ATTRIBUTE);
  if (name === null) return false;
  const url = urlFor(name);
  if (plain === null && renderedUrl(element) === url) return false;
  render(element, name, url);
  return true;
}

function decorateFrom(node: Node, urlFor: ConsoleUrlLookup): number {
  const element =
    node.nodeType === node.TEXT_NODE ? node.parentElement : (node as Element);
  if (element === null) return 0;
  return decorateElement(element, urlFor) ? 1 : 0;
}

export function decorateTree(root: Node, urlFor: ConsoleUrlLookup): number {
  let changed = decorateFrom(root, urlFor);
  if (root.nodeType === root.TEXT_NODE) return changed;
  const scope = root as Element;
  const document = root.ownerDocument ?? (root as unknown as Document);
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.nodeValue ?? "").includes(MACHINE_LINE_PREFIX)) continue;
    changed += decorateFrom(node, urlFor);
  }
  for (const element of Array.from(
    scope.querySelectorAll(`[${DECORATED_ATTRIBUTE}]`),
  )) {
    changed += decorateElement(element, urlFor) ? 1 : 0;
  }
  return changed;
}
