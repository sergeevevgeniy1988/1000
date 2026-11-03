/**
 * Small DOM helpers shared by UI modules. They never interpret HTML strings:
 * dynamic data always goes through `textContent`, attributes or dataset.
 */

/**
 * @typedef {object} ElementOptions
 * @property {string | string[]} [className]
 * @property {string | number | null} [text]
 * @property {Record<string, string | number | boolean | null | undefined>} [attrs]
 * @property {Record<string, string | number | boolean | null | undefined>} [dataset]
 */

/**
 * Creates an element with classes, text, attributes, dataset and children.
 *
 * @param {string} tag
 * @param {ElementOptions} [options]
 * @param {...(Node | string | number | null | undefined | false | Array<unknown>)} children
 * @returns {HTMLElement}
 */
export function createElement(tag, options = {}, ...children) {
  const element = document.createElement(tag);
  const {
    className,
    text,
    attrs = {},
    dataset = {},
  } = options ?? {};

  if (className) {
    element.className = Array.isArray(className)
      ? className.filter(Boolean).join(' ')
      : className;
  }

  if (text !== null && text !== undefined) {
    element.textContent = String(text);
  }

  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }

    element.setAttribute(name, value === true ? '' : String(value));
  }

  for (const [name, value] of Object.entries(dataset)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }

    element.dataset[name] = String(value);
  }

  appendChildren(element, children);

  return element;
}

/**
 * Appends text nodes and elements, skipping empty values.
 *
 * @param {Node} parent
 * @param {ReadonlyArray<unknown>} children
 * @returns {Node}
 */
function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }

    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return parent;
}

/**
 * Removes every child of an element.
 *
 * @param {Element} element
 * @returns {Element}
 */
export function clearElement(element) {
  element.replaceChildren();
  return element;
}
