import postcss from 'postcss';
import ts from 'typescript';

export interface StyleAudit {
  violations: string[];
  colors: Record<string, string[]>;
}

const scales = new Map([
  ['fontSize', '--text-'],
  ['borderRadius', '--radius-'],
  ['fontWeight', '--weight-'],
]);
const cssScales = new Map([
  ['font-size', 'fontSize'],
  ['border-radius', 'borderRadius'],
  ['font-weight', 'fontWeight'],
]);
// Named colors matter too: replacing a hex literal with `white` must not evade the baseline.
const namedColors = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
  crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
  darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
  dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
  lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
  lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
  mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
  mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy
  oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise
  palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown
  royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
  slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet
  wheat white whitesmoke yellow yellowgreen`.split(/\s+/),
);
const colorProperty =
  /^(?:color|background(?:Color)?|.*(?:Color|Shadow)|border(?:Top|Right|Bottom|Left)?|outline|fill|stroke|iconColor)$/;

function propertyName(name: ts.PropertyName): string {
  if (ts.isComputedPropertyName(name)) return name.expression.getText().replace(/^['"]|['"]$/g, '');
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}

function colorContext(node: ts.Node): boolean {
  let context = node.parent;
  while (
    ts.isConditionalExpression(context) ||
    ts.isParenthesizedExpression(context) ||
    ts.isJsxExpression(context)
  ) {
    context = context.parent;
  }
  const name = ts.isPropertyAssignment(context)
    ? propertyName(context.name)
    : ts.isJsxAttribute(context)
      ? context.name.getText()
      : ts.isBinaryExpression(context) && ts.isPropertyAccessExpression(context.left)
        ? context.left.name.text
        : '';
  return colorProperty.test(name);
}

function jsxTag(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) {
      return parent.tagName.getText();
    }
  }
}

export function auditStyles(files: Record<string, string>): StyleAudit {
  const result: StyleAudit = { violations: [], colors: {} };
  const tokens = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    if (!file.endsWith('.css')) continue;
    postcss.parse(text, { from: file }).walkDecls((decl) => {
      if (decl.prop.startsWith('--')) tokens.add(decl.prop);
    });
  }

  const isToken = (value: string, prefix: string) => {
    const match = /^var\((--[\w-]+)\)$/.exec(value);
    return !!match && match[1].startsWith(prefix) && tokens.has(match[1]);
  };
  function colors(value: string, location: string, includeNames: boolean) {
    // Strip token names, but keep any literal fallback for the color baseline.
    const withoutVars = value.replace(/var\(--[\w-]+\)/g, '').replace(/--[\w-]+/g, '');
    const matches = withoutVars.matchAll(
      /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\b[a-z]+\b/gi,
    );
    for (const [match] of matches) {
      const color = match.toLowerCase().replace(/\s+/g, '');
      if (
        !color.startsWith('#') &&
        !color.includes('(') &&
        !(includeNames && namedColors.has(color))
      )
        continue;
      (result.colors[color] ??= []).push(location);
    }
  }

  function css(text: string, file: string, lineOffset = 0) {
    postcss.parse(text, { from: file }).walkDecls((decl) => {
      if (decl.prop.startsWith('--')) return; // Token definitions are the source of truth.
      if (decl.parent?.type === 'atrule' && decl.parent.name === 'font-face') return; // Font descriptors.
      const location = `${file}:${(decl.source?.start?.line ?? 1) + lineOffset}`;
      const scale = cssScales.get(decl.prop);
      if (scale) {
        const value = decl.value.trim();
        const prose =
          decl.parent?.type === 'rule' &&
          decl.parent.selector
            .split(',')
            .every((selector) => selector.trim().startsWith('.rss-article '));
        if (
          !isToken(value, scales.get(scale)!) &&
          !(scale === 'borderRadius' && value === '50%') &&
          !(scale === 'fontSize' && prose && /^\d*\.?\d+em$/.test(value))
        ) {
          result.violations.push(`${location} ${decl.prop}: ${value}`);
        }
      }
      colors(decl.value, location, true);
    });
  }

  // A compiler host gives references their actual lexical bindings (including shadowing).
  // No libraries or dependencies are needed to resolve our own constant initializers.
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file, languageVersion) =>
    files[file] === undefined
      ? undefined
      : ts.createSourceFile(file, files[file], languageVersion, true);
  const program = ts.createProgram(
    Object.keys(files).filter((file) => /\.[jt]sx?$/.test(file)),
    options,
    host,
  );
  const checker = program.getTypeChecker();

  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith('.css')) {
      css(text, file);
      continue;
    }
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`TypeScript did not load ${file}`);
    const location = (node: ts.Node) =>
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

    function scaleValue(
      node: ts.Expression,
      name: string,
      owner: ts.Node,
      seen = new Set<ts.Node>(),
    ) {
      if (seen.has(node)) return;
      seen.add(node);
      if (ts.isConditionalExpression(node)) {
        scaleValue(node.whenTrue, name, owner, seen);
        scaleValue(node.whenFalse, name, owner, seen);
      } else if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node)
      ) {
        scaleValue(node.expression, name, owner, seen);
      } else if (ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
          scaleValue(declaration.initializer, name, owner, seen);
        } else {
          result.violations.push(`${location(owner)} ${name}: unresolved ${node.getText()}`);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(node.operatorToken.kind)
      ) {
        if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
          scaleValue(node.left, name, owner, seen);
        scaleValue(node.right, name, owner, seen);
      } else if (
        ts.isStringLiteralLike(node) ||
        ts.isNumericLiteral(node) ||
        ts.isPrefixUnaryExpression(node)
      ) {
        const value = ts.isStringLiteralLike(node) ? node.text : node.getText();
        if (isToken(value, scales.get(name)!)) return;
        if (name === 'borderRadius' && value === '50%') return;
        if (
          name === 'fontSize' &&
          file.endsWith('/ArticleReader.tsx') &&
          jsxTag(owner) === 'h1' &&
          value === 'clamp(22px, 3vw, 28px)'
        )
          return;
        // Only the two legend marks, not every radius in TrendChart.
        if (
          name === 'borderRadius' &&
          file.endsWith('/TrendChart.tsx') &&
          ts.isObjectLiteralExpression(owner.parent)
        ) {
          const dimensions = owner.parent.properties
            .filter(ts.isPropertyAssignment)
            .filter((prop) => ['width', 'height'].includes(propertyName(prop.name)))
            .map((prop) => `${propertyName(prop.name)}:${prop.initializer.getText()}`)
            .sort()
            .join(',');
          if (
            (value === '2' && dimensions === 'height:8,width:8') ||
            (value === '1' && dimensions === 'height:2,width:12')
          )
            return;
        }
        result.violations.push(`${location(owner)} ${name}: ${value}`);
      } else {
        result.violations.push(`${location(owner)} ${name}: unresolved ${node.getText()}`);
      }
    }

    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node)) {
        const name = propertyName(node.name);
        if (scales.has(name)) scaleValue(node.initializer, name, node);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        scales.has(node.left.name.text)
      ) {
        scaleValue(node.right, node.left.name.text, node);
      } else if (ts.isJsxAttribute(node) && scales.has(node.name.getText())) {
        // Numeric SVG text attributes are deliberately outside the UI type scale.
        if (
          !(node.name.getText() === 'fontSize' && ['text', 'tspan'].includes(jsxTag(node) ?? ''))
        ) {
          if (
            node.initializer &&
            ts.isJsxExpression(node.initializer) &&
            node.initializer.expression
          ) {
            scaleValue(node.initializer.expression, node.name.getText(), node);
          } else if (node.initializer && ts.isStringLiteral(node.initializer)) {
            scaleValue(node.initializer, node.name.getText(), node);
          }
        }
      }
      if (ts.isTemplateExpression(node)) {
        colors(node.getText().slice(1, -1), location(node), colorContext(node));
      }
      if (ts.isStringLiteralLike(node)) {
        const parent = node.parent;
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === node &&
          ts.isPropertyAccessExpression(parent.left) &&
          ['textContent', 'cssText'].includes(parent.left.name.text)
        ) {
          css(
            node.text,
            file,
            node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line,
          );
        } else {
          colors(node.text, location(node), colorContext(node));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return result;
}
