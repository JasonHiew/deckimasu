// src/dictionary/StructuredContent.tsx
// Renders Yomitan glossary items, including "structured-content" (a JSON DOM
// subset: lists, tables, ruby, spans, links...). Based on Yomitan's
// structured-content-generator.js (GPL-3.0-or-later). Images are shown as their
// alt/title text because dictionary media is not imported.

import { CSSProperties, ReactNode, VFC } from "react";

// Style keys Yomitan allows on structured-content nodes; anything else is dropped
const ALLOWED_STYLE_KEYS = new Set([
    'fontStyle', 'fontWeight', 'fontSize', 'color', 'background', 'backgroundColor',
    'textDecorationLine', 'textDecorationStyle', 'textDecorationColor',
    'borderColor', 'borderStyle', 'borderRadius', 'borderWidth', 'clipPath',
    'verticalAlign', 'textAlign', 'textEmphasis', 'textShadow',
    'margin', 'marginTop', 'marginLeft', 'marginRight', 'marginBottom',
    'padding', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom',
    'wordBreak', 'whiteSpace', 'cursor', 'listStyleType',
]);

const NUMERIC_EM_KEYS = new Set([
    'marginTop', 'marginLeft', 'marginRight', 'marginBottom',
]);

function convertStyle(style: any): CSSProperties | undefined {
    if (!style || typeof style !== 'object') return undefined;
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(style)) {
        if (!ALLOWED_STYLE_KEYS.has(key)) continue;
        if (key === 'textDecorationLine' && Array.isArray(value)) {
            out.textDecorationLine = value.join(' ');
        } else if (NUMERIC_EM_KEYS.has(key) && typeof value === 'number') {
            out[key] = `${value}em`;
        } else {
            out[key] = value;
        }
    }
    return out;
}

// Per data-content styling for the common JMdict blocks
function dataStyle(data: any): CSSProperties {
    switch (data?.content) {
        case 'notes':
        case 'infoGlossary':
            return { fontSize: '85%', opacity: 0.85 };
        case 'references':
        case 'antonyms':
        case 'sourceLanguages':
            return { fontSize: '85%', opacity: 0.75 };
        case 'formsTable':
            return { fontSize: '85%' };
        default:
            return {};
    }
}

const TABLE_CELL_STYLE: CSSProperties = {
    border: '1px solid rgba(255,255,255,0.25)',
    padding: '2px 6px',
};

function parseLookupLink(href: string): string | null {
    // JMdict cross references look like "?query=来る&wildcards=off"
    if (!href || !href.startsWith('?')) return null;
    for (const part of href.slice(1).split('&')) {
        const [k, v] = part.split('=');
        if (k === 'query' && v) {
            try { return decodeURIComponent(v); } catch { return v; }
        }
    }
    return null;
}

interface RenderContext {
    onLookup?: (term: string) => void;
}

function renderNode(node: any, ctx: RenderContext, key: number | string): ReactNode {
    if (node === null || node === undefined) return null;
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map((child, i) => renderNode(child, ctx, i));
    if (typeof node !== 'object') return null;

    const tag: string = node.tag;
    const children = renderNode(node.content, ctx, 'c');
    const style: CSSProperties = { ...dataStyle(node.data), ...(convertStyle(node.style) || {}) };
    const lang = typeof node.lang === 'string' ? node.lang : undefined;
    const title = typeof node.title === 'string' ? node.title : undefined;

    switch (tag) {
        case 'br':
            return <br key={key} />;
        case 'ruby':
            return <ruby key={key} lang={lang} style={style}>{children}</ruby>;
        case 'rt':
            return <rt key={key} style={style}>{children}</rt>;
        case 'rp':
            return <rp key={key} style={style}>{children}</rp>;
        case 'table':
            return (
                <table key={key} lang={lang} style={{ borderCollapse: 'collapse', margin: '4px 0', ...style }}>
                    {children}
                </table>
            );
        case 'thead':
            return <thead key={key} style={style}>{children}</thead>;
        case 'tbody':
            return <tbody key={key} style={style}>{children}</tbody>;
        case 'tfoot':
            return <tfoot key={key} style={style}>{children}</tfoot>;
        case 'tr':
            return <tr key={key} style={style}>{children}</tr>;
        case 'th':
        case 'td': {
            const Cell = tag as "td" | "th";
            return (
                <Cell key={key} lang={lang} colSpan={node.colSpan} rowSpan={node.rowSpan}
                      style={{ ...TABLE_CELL_STYLE, fontWeight: tag === 'th' ? 'bold' : undefined, ...style }}>
                    {children}
                </Cell>
            );
        }
        case 'ul':
        case 'ol': {
            // Compact glossaries (like Yomitan's option): glosses inline, "; " separated
            if (node.data?.content === 'glossary') {
                const items = Array.isArray(node.content) ? node.content : [node.content];
                return (
                    <span key={key} lang={lang}>
                        {items.map((item: any, i: number) => (
                            <span key={i}>
                                {i > 0 && '; '}
                                {renderNode(item?.tag === 'li' ? item.content : item, ctx, i)}
                            </span>
                        ))}
                    </span>
                );
            }
            const List = tag as "ul" | "ol";
            return (
                <List key={key} lang={lang} title={title}
                      style={{ margin: '2px 0', paddingLeft: '1.3em', ...style }}>
                    {children}
                </List>
            );
        }
        case 'li':
            return <li key={key} lang={lang} title={title} style={style}>{children}</li>;
        case 'details':
            return <details key={key} open={!!node.open} lang={lang} style={style}>{children}</details>;
        case 'summary':
            return <summary key={key} style={style}>{children}</summary>;
        case 'div':
            return <div key={key} lang={lang} title={title} style={style}>{children}</div>;
        case 'span':
            return <span key={key} lang={lang} title={title} style={style}>{children}</span>;
        case 'a': {
            const query = parseLookupLink(node.href);
            return (
                <span
                    key={key}
                    lang={lang}
                    onClick={query && ctx.onLookup ? (e) => { e.stopPropagation(); ctx.onLookup!(query); } : undefined}
                    style={{ color: '#7fb8ff', textDecoration: 'underline', cursor: query ? 'pointer' : 'default', ...style }}
                >
                    {children}
                </span>
            );
        }
        case 'img': {
            const label = node.alt || node.title || node.description;
            return label ? <span key={key} style={{ opacity: 0.7 }}>[{label}]</span> : null;
        }
        default:
            return children ? <span key={key} style={style}>{children}</span> : null;
    }
}

export const Glossary: VFC<{ items: any[]; onLookup?: (term: string) => void }> = ({ items, onLookup }) => {
    const ctx: RenderContext = { onLookup };
    const plain: string[] = [];
    const rich: ReactNode[] = [];

    items.forEach((item, i) => {
        if (typeof item === 'string') {
            plain.push(item);
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
            if (item.type === 'text' && typeof item.text === 'string') {
                plain.push(item.text);
            } else if (item.type === 'structured-content') {
                // Inline wrapper so a sense's tags and glosses share a line; block
                // children (notes, tables) still start their own lines
                rich.push(<span key={i}>{renderNode(item.content, ctx, i)}</span>);
            } else if (item.type === 'image') {
                const label = item.alt || item.title || item.description;
                if (label) rich.push(<div key={i} style={{ opacity: 0.7 }}>[{label}]</div>);
            }
        }
        // [uninflected, rules] redirect entries are not displayed
    });

    return (
        <>
            {plain.length > 0 && <span>{plain.join('; ')}</span>}
            {rich}
        </>
    );
};
