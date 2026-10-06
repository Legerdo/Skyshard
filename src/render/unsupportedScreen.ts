import { createButton, createSystemScreen, h } from './systemScreen';

/* Korean notice shown instead of the game when WebGL2 is unavailable (Req 1.5, 1.7). */

const SCREEN_ID = 'webgl-unsupported';

function code(text: string): HTMLElement {
  return h('code', undefined, text);
}

function item(label: string, ...hint: (string | Node)[]): HTMLLIElement {
  const li = h('li');
  li.append(h('span', undefined, label));
  if (hint.length > 0) {
    const detail = h('span', 'sys-list__hint');
    detail.append(...hint);
    li.append(detail);
  }
  return li;
}

function listSection(heading: string, items: HTMLLIElement[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const list = h('ul', 'sys-list');
  list.append(...items);
  fragment.append(h('h3', 'sys-panel__heading', heading), list);
  return fragment;
}

/** Mounts the full-screen notice on `root` (idempotent) and returns it. */
export function showUnsupportedScreen(root: HTMLElement): HTMLElement {
  const existing = root.querySelector<HTMLElement>(`#${SCREEN_ID}`);
  if (existing) return existing;

  const { screen, panel } = createSystemScreen({
    id: SCREEN_ID,
    role: 'alertdialog',
    opaque: true,
    title: 'WebGL2를 사용할 수 없습니다',
    text:
      'Skyshard: Echoes of the Wild는 3D 화면을 그리는 데 WebGL2가 필요하지만, ' +
      '지금 브라우저에서 WebGL2를 시작하지 못했습니다.',
  });

  const retry = createButton('다시 시도', () => location.reload());
  const actions = h('div', 'sys-actions');
  actions.append(retry);

  panel.append(
    listSection('지원 브라우저', [item('최신 데스크톱 Chrome'), item('최신 데스크톱 Microsoft Edge')]),
    listSection('해결 방법', [
      item(
        '브라우저 설정에서 하드웨어 가속 켜기',
        'Chrome은 ',
        code('chrome://settings/system'),
        ', Edge는 ',
        code('edge://settings/system'),
        ' 주소에서 그래픽 가속 사용을 켜고 브라우저를 다시 시작하세요.',
      ),
      item('그래픽 드라이버 업데이트', '그래픽 카드 제조사 사이트나 운영체제 업데이트로 최신 드라이버를 설치하세요.'),
      item('브라우저 업데이트', 'Chrome 또는 Edge를 최신 버전으로 업데이트한 뒤 다시 시도하세요.'),
    ]),
    actions,
  );

  root.append(screen);
  retry.focus();
  return screen;
}
