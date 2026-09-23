import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, MD_COMPONENTS } from './markdownConfig.js';

/**
 * D-1 — agent prose, rendered.
 *
 * The defect this removes was visible on every interesting turn: the model
 * writes GitHub-flavoured markdown, and the bubble printed it verbatim, so a
 * comparison table arrived as a wall of ASCII pipes and `**Vendor issue: **`
 * kept its asterisks. On a page whose whole claim is "you can read what the
 * agent did", that is not cosmetic.
 *
 * The plugin list and the element overrides live in ./markdownConfig.js so the
 * offline suite can render them; what is left here is the wrapper the styles
 * hang off. Paragraphs keep `white-space: pre-wrap` (see styles.css): markdown
 * folds single newlines, which would silently reflow the model's line-broken
 * output, and the CSS gives that back without a third remark plugin deciding
 * it for us.
 */
export default function Markdown({ text }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
        {text || ''}
      </ReactMarkdown>
    </div>
  );
}
