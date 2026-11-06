// Gives a view its own child element inside the shared page area, so its
// event handlers go away with it when the page changes.
export function makeHost(root) {
  root.innerHTML = '';
  const host = root.ownerDocument.createElement('div');
  root.appendChild(host);
  return host;
}

// True while the view's element is still on screen (the page has not changed).
export const isAlive = (host, root) => host.parentNode === root;
