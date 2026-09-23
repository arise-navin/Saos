import { createElement } from 'react';
import remarkGfm from 'remark-gfm';

/**
 * The markdown pipeline, in plain JS so it can be rendered — and asserted —
 * outside a browser.
 *
 * This is deliberately not inlined into Markdown.jsx. The claim being made in
 * D-1 is behavioural ("`**bold**` stops arriving as asterisks, ASCII pipe
 * tables become tables"), and a claim about rendering has to be measured by
 * rendering. `server/test/markdown.test.js` imports THIS module, so the test
 * exercises the same plugin list and the same element overrides the app ships,
 * not a copy of them that can drift.
 *
 * No `rehype-raw`, and none should ever be added: react-markdown drops raw HTML
 * by default and this text is written by a language model.
 */

export const REMARK_PLUGINS = [remarkGfm];

/**
 * react-markdown hands every override the mdast `node` alongside the DOM props.
 * Spreading that straight onto an element renders `node="[object Object]"` into
 * the HTML and makes React log "does not recognize the `node` prop" on every
 * message. Caught by rendering it, not by reading the types.
 */
const domProps = ({ node, ...rest }) => rest; // eslint-disable-line no-unused-vars

export const MD_COMPONENTS = {
  // Every link the agent emits points at the bound instance. Losing the
  // transcript — and any in-flight approval card — to a navigation is a real
  // failure, so they leave in a new tab.
  a: (props) => createElement('a', { ...domProps(props), target: '_blank', rel: 'noreferrer noopener' }),
  // Wide tables scroll inside the bubble instead of stretching the column.
  table: (props) => createElement('div', { className: 'md-table-wrap' }, createElement('table', domProps(props))),
};
