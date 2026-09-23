import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, MD_COMPONENTS } from '../src/components/markdownConfig.js';

/**
 * Test support for D-1 — renders agent text through the EXACT pipeline the
 * chat bubble uses, and hands back HTML a non-browser test can assert on.
 *
 * It lives under client/test rather than client/src for two reasons: nothing
 * in the app should be able to import `react-dom/server` by accident, and a
 * bare specifier resolves against the importing file's package, so this is
 * also what lets `server/test/markdown.test.js` reach client/node_modules at
 * all.
 */
export function renderMarkdown(text) {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: REMARK_PLUGINS, components: MD_COMPONENTS }, text)
  );
}
