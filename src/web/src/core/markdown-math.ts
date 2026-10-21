import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Construct, Extension, State, Tokenizer } from "micromark-util-types";
import remarkMath from "remark-math";
import type {} from "remark-parse";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    texMath: "texMath";
    texMathMarker: "texMathMarker";
    texMathValue: "texMathValue";
  }
}

// Failed EOF scans are cached per CommonMark text tokenizer, never globally
// across documents or streaming updates. Later unmatched openers in that suffix
// can then fail immediately instead of repeatedly scanning the same tail.
const failedSuffixes = new WeakMap<object, Map<number, number>>();

/** Native inline syntax: CommonMark owns code, escapes and container prefixes. */
const tokenize: Tokenizer = function (effects, ok, nok) {
  const offset = this.now().offset;
  let closing: number;
  let previous = 0;
  let slashRun = 0;
  let inData = false;
  const start: State = (code) => {
    effects.enter("texMath");
    effects.enter("texMathMarker");
    effects.consume(code);
    return opening;
  };
  const opening: State = (code) => {
    if (code !== 40 && code !== 91) return nok(code);
    closing = code === 40 ? 41 : 93;
    const failedFrom = failedSuffixes.get(this)?.get(closing);
    if (failedFrom !== undefined && offset >= failedFrom) return nok(code);
    effects.consume(code);
    effects.exit("texMathMarker");
    return body;
  };
  const body: State = (code) => {
    if (code === null) {
      const failures = failedSuffixes.get(this) ?? new Map<number, number>();
      failures.set(closing, Math.min(failures.get(closing) ?? offset, offset));
      failedSuffixes.set(this, failures);
      return nok(code); // incomplete streaming spans remain literal
    }
    if (code === 92) {
      previous = slashRun;
      slashRun++;
      return effects.check(close, finish, consume)(code);
    }
    slashRun = 0;
    if (code === -5 || code === -4 || code === -3) {
      if (inData) effects.exit("texMathValue");
      inData = false;
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return body;
    }
    if (!inData) effects.enter("texMathValue");
    inData = true;
    effects.consume(code);
    return body;
  };
  const close: Construct = {
    tokenize(checkEffects, checkOk, checkNok) {
      return (code) => {
        if (previous % 2 !== 0) return checkNok(code);
        checkEffects.consume(code);
        return (next) => {
          if (next !== closing) return checkNok(next);
          checkEffects.consume(next);
          return checkOk;
        };
      };
    },
  };
  const consume: State = (code) => {
    if (!inData) effects.enter("texMathValue");
    inData = true;
    effects.consume(code);
    return body;
  };
  const finish: State = (code) => {
    if (inData) effects.exit("texMathValue");
    effects.enter("texMathMarker");
    effects.consume(code);
    return (next) => {
      effects.consume(next);
      effects.exit("texMathMarker");
      effects.exit("texMath");
      return ok;
    };
  };
  return start;
};

const syntax: Extension = { text: { 92: { name: "texMath", tokenize } } };
const fromMarkdown: FromMarkdownExtension = {
  enter: {
    texMath(token) {
      const display = this.sliceSerialize(token).startsWith("\\[");
      this.enter(
        {
          type: "inlineMath",
          value: "",
          data: {
            hName: display ? "pre" : "code",
            hProperties: display ? {} : { className: ["language-math", "math-inline"] },
          },
        },
        token,
      );
      this.buffer();
    },
  },
  exit: {
    texMathValue(token) {
      this.config.enter.data.call(this, token);
      this.config.exit.data.call(this, token);
    },
    texMath(token) {
      const value = this.resume();
      const node = this.stack[this.stack.length - 1];
      if (node.type === "inlineMath") {
        node.value = value.trim();
        const text = { type: "text" as const, value: node.value };
        node.data ??= {};
        node.data.hChildren =
          node.data.hName === "pre"
            ? [
                {
                  type: "element",
                  tagName: "code",
                  properties: { className: ["language-math", "math-display"] },
                  children: [text],
                },
              ]
            : [text];
      }
      this.exit(token);
    },
  },
};

/** Keep Streamdown's existing dollar policy and KaTeX rehype safety defaults. */
export function remarkTexMath(this: Processor) {
  remarkMath.call(this, { singleDollarTextMath: false });
  const data = this.data();
  data.micromarkExtensions ??= [];
  data.fromMarkdownExtensions ??= [];
  data.micromarkExtensions.push(syntax);
  data.fromMarkdownExtensions.push(fromMarkdown);
}
