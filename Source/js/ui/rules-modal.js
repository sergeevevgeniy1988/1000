import { RULES_SECTIONS } from '../content/rules.js';
import { createElement } from './dom.js';
import { closeModal, openModal } from './modals.js';

/**
 * @param {object} block
 * @returns {HTMLElement}
 */
function createList(block) {
  const ordered = block.type === 'ordered-list';
  const list = createElement(ordered ? 'ol' : 'ul', {
    className: ['rules__list', ordered ? 'rules__list--ordered' : ''],
  });

  for (const item of block.items ?? []) {
    list.append(createElement('li', { text: item }));
  }

  return list;
}

/**
 * @param {object} block
 * @returns {HTMLElement}
 */
function createRulesTable(block) {
  const wrapper = createElement('div', { className: 'rules-table-wrap' });
  const table = createElement('table', { className: 'rules-table' });

  if (block.caption) {
    table.append(createElement('caption', { text: block.caption }));
  }

  const head = createElement('thead');
  const headRow = createElement('tr');

  for (const header of block.headers) {
    headRow.append(createElement('th', {
      text: header,
      attrs: { scope: 'col' },
    }));
  }

  head.append(headRow);

  const body = createElement('tbody');

  for (const row of block.rows) {
    const rowEl = createElement('tr');

    for (const cell of row) {
      rowEl.append(createElement('td', { text: cell }));
    }

    body.append(rowEl);
  }

  table.append(head, body);
  wrapper.append(table);

  return wrapper;
}

/**
 * @param {object} block
 * @returns {HTMLElement}
 */
function createExample(block) {
  const example = createElement('div', { className: 'rules-example' });

  example.append(createElement('h4', {
    className: 'rules-example__title',
    text: block.title,
  }));

  for (const line of block.lines) {
    example.append(createElement('p', {
      className: 'rules-example__line',
      text: line,
    }));
  }

  return example;
}

/**
 * @param {object} block
 * @returns {HTMLElement | null}
 */
function createBlock(block) {
  switch (block.type) {
    case 'paragraph':
      return createElement('p', { className: 'rules__paragraph', text: block.text });
    case 'list':
    case 'ordered-list':
      return createList(block);
    case 'note':
      return createElement('aside', { className: 'rules__note', text: block.text });
    case 'table':
      return createRulesTable(block);
    case 'example':
      return createExample(block);
    default:
      return null;
  }
}

/**
 * Builds the complete rules text from the content module.
 *
 * @returns {HTMLElement}
 */
export function createRulesContent() {
  const root = createElement('div', { className: 'rules' });

  root.append(createElement('p', {
    className: 'rules__intro',
    text: '«Тысяча» — карточная игра на троих до 1000 очков. Ниже собраны полные правила версии 1.0, включая стоимость карт, марьяжи и примеры подсчёта.',
  }));

  for (const section of RULES_SECTIONS) {
    const sectionEl = createElement('section', {
      className: 'rules__section',
      attrs: { id: `rules-${section.id}`, 'aria-labelledby': `rules-${section.id}-title` },
    });

    sectionEl.append(createElement('h3', {
      className: 'rules__section-title',
      text: section.title,
      attrs: { id: `rules-${section.id}-title` },
    }));

    for (const block of section.blocks) {
      const element = createBlock(block);

      if (element) {
        sectionEl.append(element);
      }
    }

    root.append(sectionEl);
  }

  return root;
}

/**
 * Opens the full rules dialog. The shared modal helper provides the focus
 * trap, Escape handling, backdrop and scrollable body.
 *
 * @param {object} [options]
 * @param {(() => void) | null} [options.onClose]
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openRulesModal({ onClose = null } = {}) {
  return openModal({
    kind: 'rules',
    title: 'Правила игры',
    subtitle: 'Полные правила «Тысячи» для трёх игроков',
    body: createRulesContent(),
    actions: [
      {
        label: 'Понятно',
        variant: 'primary',
        onClick: () => closeModal(),
      },
    ],
    dismissible: true,
    wide: true,
    className: 'modal--rules',
    onClose,
  });
}
