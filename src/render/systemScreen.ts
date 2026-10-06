import './systemScreen.css';

/* Shared DOM builders for full-screen system panels (WebGL2 notice, context-loss overlay). */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export interface SystemScreenParts {
  screen: HTMLDivElement;
  panel: HTMLElement;
  title: HTMLHeadingElement;
  text: HTMLParagraphElement;
}

export interface SystemScreenOptions {
  /** Element id; the title and text get `${id}-title` / `${id}-text`. */
  id: string;
  role: 'dialog' | 'alertdialog';
  title: string;
  text: string;
  /** Opaque backdrop instead of a translucent one. */
  opaque?: boolean;
}

/** Full-screen backdrop with a centered modal panel (title + description). Not mounted. */
export function createSystemScreen(opts: SystemScreenOptions): SystemScreenParts {
  const screen = h('div', opts.opaque ? 'sys-screen sys-screen--opaque' : 'sys-screen');
  screen.id = opts.id;
  const panel = h('section', 'sys-panel');
  panel.setAttribute('role', opts.role);
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `${opts.id}-title`);
  panel.setAttribute('aria-describedby', `${opts.id}-text`);
  const title = h('h2', 'sys-panel__title', opts.title);
  title.id = `${opts.id}-title`;
  const text = h('p', 'sys-panel__text', opts.text);
  text.id = `${opts.id}-text`;
  panel.append(title, text);
  screen.append(panel);
  return { screen, panel, title, text };
}

export function createButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', 'sys-button', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}
