"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { createHighlighter } from "shiki";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { createBoundedAsyncCache } from "../../src/core/bounded-async-cache";
import { t, useLanguage } from "../../src/core/i18n";
import {
  canHighlight,
  HIGHLIGHT_MAX_TOKENS,
  highlightKey,
  PLAIN_PAGE_CHARS,
  PLAIN_PAGE_LINES,
  textWindow,
} from "../../src/core/text-window";

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) =>
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4;

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
interface KeyedToken {
  token: ThemedToken;
  key: string;
}
interface KeyedLine {
  tokens: KeyedToken[];
  key: string;
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }));

// Token rendering component
const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
    style={
      {
        backgroundColor: token.bgColor,
        color: token.color,
        fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
        fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
        textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
        ...token.htmlStyle,
      } as CSSProperties
    }
  >
    {token.content}
  </span>
);

// Line number styles using CSS counters
const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-muted-foreground/50",
  "before:font-mono",
  "before:select-none",
);

// Line rendering component
const LineSpan = ({ keyedLine, showLineNumbers }: { keyedLine: KeyedLine; showLineNumbers: boolean }) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
    {keyedLine.tokens.length === 0
      ? "\n"
      : keyedLine.tokens.map(({ token, key }) => <TokenSpan key={key} token={token} />)}
  </span>
);

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  /** Copy actions retain the complete source even when the visible code is a preview. */
  copyCode?: string;
};

interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
  plain?: boolean;
}

interface CodeBlockContextType {
  code: string;
}

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

// One engine/theme pair, with deduplicated language loading (not an engine per language).
let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | undefined;
const languageLoads = new Map<string, Promise<void>>();
const tokensCache = createBoundedAsyncCache<TokenizedCode>({
  maxEntries: 64,
  maxWeight: 8_000_000,
  maxPending: 16,
  weight: (value, key) =>
    key.length * 2 +
    value.tokens.reduce((sum, line) => sum + line.reduce((size, token) => size + 160 + token.content.length * 2, 0), 0),
});

async function getHighlighter(language: BundledLanguage) {
  highlighterPromise ??= createHighlighter({
    langs: [],
    themes: ["github-light", "github-dark"],
  }).catch((error) => {
    highlighterPromise = undefined;
    throw error;
  });
  const highlighter = await highlighterPromise;
  if (!highlighter.getLoadedLanguages().includes(language)) {
    let loading = languageLoads.get(language);
    if (!loading) {
      loading = highlighter.loadLanguage(language).finally(() => languageLoads.delete(language));
      languageLoads.set(language, loading);
    }
    await loading;
  }
  return highlighter;
}

async function requestHighlight(code: string, language: BundledLanguage): Promise<TokenizedCode | undefined> {
  if (!canHighlight(code)) return undefined;
  return tokensCache.load(highlightKey(code, language), async () => {
    const highlighter = await getHighlighter(language);
    // Yield a task before CPU tokenization, even with an already-loaded engine.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const result = highlighter.codeToTokens(code, {
      lang: language,
      themes: { dark: "github-dark", light: "github-light" },
    });
    // Bound token DOM too: punctuation-heavy inputs can have many tokens per line.
    if (result.tokens.reduce((count, line) => count + line.length, 0) > HIGHLIGHT_MAX_TOKENS) {
      // Cache the decision too, so remounting a dense snippet does not retokenize it.
      return { bg: "transparent", fg: "inherit", tokens: [], plain: true };
    }
    return { bg: result.bg ?? "transparent", fg: result.fg ?? "inherit", tokens: result.tokens };
  });
}

// Compatibility API: callers get cached tokens or an asynchronous notification.
// CodeBlockContent invokes this only after commit, never during render.
export const highlightCode = (
  code: string,
  language: BundledLanguage,
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!canHighlight(code)) return null;
  const cached = tokensCache.get(highlightKey(code, language));
  if (cached) return cached;
  void requestHighlight(code, language)
    .then((result) => {
      if (result) callback?.(result);
    })
    .catch(() => {
      /* Unsupported languages/failures keep the original plain text. */
    });
  return null;
};

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    className,
  }: {
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    className?: string;
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg],
    );

    const keyedLines = useMemo(() => addKeysToTokens(tokenized.tokens), [tokenized.tokens]);

    return (
      <pre
        className={cn("dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)] m-0 p-4 text-sm", className)}
        style={preStyle}
      >
        <code className={cn("font-mono text-sm", showLineNumbers && "[counter-increment:line_0] [counter-reset:line]")}>
          {keyedLines.map((keyedLine) => (
            <LineSpan key={keyedLine.key} keyedLine={keyedLine} showLineNumbers={showLineNumbers} />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className,
);

CodeBlockBody.displayName = "CodeBlockBody";

export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn("group relative w-full overflow-hidden rounded-md border bg-background text-foreground", className)}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
);

export const CodeBlockHeader = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-center justify-between border-b bg-muted/80 px-3 py-2 text-muted-foreground text-xs",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockTitle = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export const CodeBlockFilename = ({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
);

export const CodeBlockActions = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("-my-1 -mr-1 flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

// A single text node per page avoids raw-token arrays and thousands of line spans.
const PlainCode = ({ code, paged }: { code: string; paged: boolean }) => {
  useLanguage();
  const [position, setPosition] = useState({ code, starts: [0] });
  const starts = position.code === code ? position.starts : [0];
  const start = starts[starts.length - 1];
  const page = useMemo(() => textWindow(code, start, PLAIN_PAGE_LINES, PLAIN_PAGE_CHARS), [code, start]);
  const needsPages = paged && (start > 0 || page.hasMore);
  return (
    <div data-code-rendering="plain">
      {paged && (
        <p className="px-4 pt-2 text-muted-foreground text-xs" data-code-plain-notice>
          {needsPages
            ? t("Large content is shown as plain text in pages. Copy includes the full content.")
            : t("Syntax highlighting is disabled for large content.")}
        </p>
      )}
      <pre className="m-0 p-4 text-sm">
        <code className="font-mono">{paged ? page.text : code}</code>
      </pre>
      {needsPages && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-3 py-2" data-code-pagination>
          <span className="mr-auto text-muted-foreground text-xs">
            {t("Characters {start}–{end} of {total}", { start: start + 1, end: page.end, total: code.length })}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={starts.length === 1}
            onClick={() => setPosition({ code, starts: starts.slice(0, -1) })}
          >
            {t("Previous page")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!page.hasMore}
            onClick={() => setPosition({ code, starts: [...starts, page.end] })}
          >
            {t("Next page")}
          </Button>
        </div>
      )}
    </div>
  );
};

export const CodeBlockContent = memo(function CodeBlockContent({
  code,
  language,
  showLineNumbers = false,
}: {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
}) {
  const eligible = useMemo(() => canHighlight(code), [code]);
  const [result, setResult] = useState<{ code: string; language: BundledLanguage; tokens: TokenizedCode } | null>(null);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    const accept = (tokens: TokenizedCode) => {
      if (!cancelled) setResult({ code, language, tokens });
    };
    const cached = highlightCode(code, language, accept);
    if (cached) accept(cached);
    return () => {
      cancelled = true;
    };
  }, [code, language, eligible]);

  const tokens = result?.code === code && result.language === language ? result.tokens : null;
  return (
    <div className="relative overflow-auto">
      {tokens && !tokens.plain ? (
        <CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokens} />
      ) : (
        <PlainCode code={code} paged={!eligible || Boolean(tokens?.plain)} />
      )}
    </div>
  );
});

export const CodeBlock = ({
  code,
  copyCode = code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code: copyCode }), [copyCode]);

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent code={code} language={language} showLineNumbers={showLineNumbers} />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  useLanguage();
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error(t("Clipboard API not available")));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      aria-label={t("Copy code")}
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (props: CodeBlockLanguageSelectorProps) => <Select {...props} />;

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<typeof SelectTrigger>;

export const CodeBlockLanguageSelectorTrigger = ({ className, ...props }: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn("h-7 border-none bg-transparent px-2 text-xs shadow-none", className)}
    size="sm"
    {...props}
  />
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<typeof SelectValue>;

export const CodeBlockLanguageSelectorValue = (props: CodeBlockLanguageSelectorValueProps) => (
  <SelectValue {...props} />
);

export type CodeBlockLanguageSelectorContentProps = ComponentProps<typeof SelectContent>;

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => <SelectContent align={align} {...props} />;

export type CodeBlockLanguageSelectorItemProps = ComponentProps<typeof SelectItem>;

export const CodeBlockLanguageSelectorItem = (props: CodeBlockLanguageSelectorItemProps) => <SelectItem {...props} />;
