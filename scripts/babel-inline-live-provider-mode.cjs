// Production Web/Release bundleでは、Metroがlive providerを選択した後に
// mock用mode分岐を残さない。開発・CIのmock経路はこの変換を有効にしない。

const INLINE_MARKER = '_inlineLiveProviderMode';

function staticValue(path) {
  const node = path.node;
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') {
    return { confident: true, value: node.value };
  }
  if (node.type === 'NullLiteral') return { confident: true, value: null };
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const argument = staticValue(path.get('argument'));
    return argument.confident
      ? { confident: true, value: !argument.value }
      : { confident: false };
  }
  if (node.type === 'BinaryExpression' && ['===', '!=='].includes(node.operator)) {
    const left = staticValue(path.get('left'));
    const right = staticValue(path.get('right'));
    if (!left.confident || !right.confident) return { confident: false };
    const value =
      node.operator === '===' ? left.value === right.value : left.value !== right.value;
    return { confident: true, value };
  }
  if (node.type === 'LogicalExpression' && ['&&', '||'].includes(node.operator)) {
    const left = staticValue(path.get('left'));
    if (!left.confident) return { confident: false };
    if (node.operator === '&&' && !left.value) return { confident: true, value: false };
    if (node.operator === '||' && left.value) return { confident: true, value: true };
    const right = staticValue(path.get('right'));
    return right.confident ? { confident: true, value: right.value } : { confident: false };
  }
  return { confident: false };
}

function foldConditional(path, t) {
  if (!hasInlineMarker(path.node.test)) return;
  const test = staticValue(path.get('test'));
  if (!test.confident) return;
  const replacement = t.cloneNode(test.value ? path.node.consequent : path.node.alternate, true);
  replacement[INLINE_MARKER] = true;
  path.replaceWith(replacement);
}

function markLiteral(node) {
  node[INLINE_MARKER] = true;
  return node;
}

function hasInlineMarker(node) {
  return Boolean(node?.[INLINE_MARKER]);
}

function foldStaticExpression(path, t) {
  if (!hasInlineMarker(path.node.left) && !hasInlineMarker(path.node.right)) return;
  const value = staticValue(path);
  if (!value.confident) return;
  const replacement = value.value === null ? t.nullLiteral() : t.valueToNode(value.value);
  path.replaceWith(markLiteral(replacement));
}

function foldLogicalExpression(path, t) {
  const { node } = path;
  if (!hasInlineMarker(node.left) && !hasInlineMarker(node.right)) return;
  const left = staticValue(path.get('left'));
  if (!left.confident) return;
  if (node.operator === '&&' && !left.value) {
    path.replaceWith(markLiteral(t.booleanLiteral(false)));
    return;
  }
  if (node.operator === '||' && left.value) {
    path.replaceWith(markLiteral(t.booleanLiteral(true)));
    return;
  }
  if (node.operator === '&&' || node.operator === '||') {
    const replacement = t.cloneNode(node.right, true);
    replacement[INLINE_MARKER] = true;
    path.replaceWith(replacement);
  }
}

function isApplicationSource(path) {
  const filename = path.hub.file.opts.filename.replaceAll('\\', '/');
  const root = process.cwd().replaceAll('\\', '/').replace(/\/$/u, '');
  return filename.startsWith(`${root}/src/`) || filename.startsWith(`${root}/app/`);
}

module.exports = function inlineLiveProviderMode({ types: t }) {
  return {
    name: 'inline-live-provider-mode',
    visitor: {
      ImportDeclaration(path) {
        if (!isApplicationSource(path) || path.node.source.value !== '@/lib/api') return;
        const specifier = path.node.specifiers.find(
          (item) => item.type === 'ImportSpecifier' && item.imported.name === 'dataProviderMode',
        );
        if (!specifier) return;

        const binding = path.scope.getBinding(specifier.local.name);
        for (const reference of binding?.referencePaths ?? []) {
          reference.replaceWith(markLiteral(t.stringLiteral('live')));
        }
        path.node.specifiers = path.node.specifiers.filter((item) => item !== specifier);
        if (path.node.specifiers.length === 0) path.remove();
      },
      VariableDeclarator(path) {
        if (!isApplicationSource(path)) return;
        if (path.node.id.type === 'Identifier' && path.node.id.name === 'dataProviderMode') {
          const binding = path.scope.getBinding(path.node.id.name);
          for (const reference of binding?.referencePaths ?? []) {
            reference.replaceWith(markLiteral(t.stringLiteral('live')));
          }
          path.get('init').replaceWith(markLiteral(t.stringLiteral('live')));
        }
      },
      BinaryExpression: {
        exit(path) {
          if (isApplicationSource(path)) foldStaticExpression(path, t);
        },
      },
      LogicalExpression: {
        exit(path) {
          if (isApplicationSource(path)) foldLogicalExpression(path, t);
        },
      },
      ConditionalExpression: {
        exit(path) {
          if (isApplicationSource(path)) foldConditional(path, t);
        },
      },
      IfStatement: {
        exit(path) {
          if (!isApplicationSource(path)) return;
          const test = staticValue(path.get('test'));
          if (!hasInlineMarker(path.node.test) || !test.confident) return;
          if (test.value) {
            path.replaceWith(path.node.consequent);
          } else if (path.node.alternate) {
            path.replaceWith(path.node.alternate);
          } else {
            path.remove();
          }
        },
      },
    },
  };
};
