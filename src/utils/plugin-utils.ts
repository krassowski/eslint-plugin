/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { TSESTree } from '@typescript-eslint/types';
import { ASTUtils, TSESLint } from '@typescript-eslint/utils';
import * as ts from 'typescript';

export type JupyterPluginKind = 'frontend' | 'service-manager';

/**
 * Gets plugin kind from a variable declaration type annotation.
 * Accepts an optional TS checker and node mapper to resolve import aliases
 * (e.g. `import { JupyterFrontEndPlugin as JFEP } from '@jupyterlab/application'`).
 */
export function getJupyterPluginKind(
  node: TSESTree.VariableDeclarator,
  checker?: ts.TypeChecker | null,
  getTSNode?: ((n: TSESTree.Node) => ts.Node | undefined) | null
): JupyterPluginKind | null {
  const id = node.id;
  if (id.type !== 'Identifier' || !id.typeAnnotation) {
    return null;
  }

  const typeNode = id.typeAnnotation.typeAnnotation;
  if (typeNode.type !== 'TSTypeReference') {
    return null;
  }

  // Fast path: direct string match (no alias).
  const pluginTypeName = extractTypeName(typeNode.typeName);
  if (pluginTypeName === 'JupyterFrontEndPlugin') {
    return 'frontend';
  }
  if (pluginTypeName === 'ServiceManagerPlugin') {
    return 'service-manager';
  }

  // Slow path: resolve import aliases via the TS checker.
  if (checker && getTSNode && typeNode.typeName.type === 'Identifier') {
    const resolvedName = resolveTypeAlias(
      typeNode.typeName,
      checker,
      getTSNode
    );
    if (resolvedName === 'JupyterFrontEndPlugin') {
      return 'frontend';
    }
    if (resolvedName === 'ServiceManagerPlugin') {
      return 'service-manager';
    }
  }

  return null;
}

/**
 * Extracts properties from an object expression
 */
export function getObjectProperties(
  obj: TSESTree.ObjectExpression
): Map<string, TSESTree.Property> {
  const props = new Map<string, TSESTree.Property>();
  for (const prop of obj.properties) {
    if (prop.type === 'Property' && !prop.computed) {
      let keyName: string | null = null;
      if (prop.key.type === 'Identifier') {
        keyName = prop.key.name;
      } else if (
        prop.key.type === 'Literal' &&
        typeof prop.key.value === 'string'
      ) {
        keyName = prop.key.value;
      }
      if (keyName) {
        props.set(keyName, prop);
      }
    }
  }
  return props;
}

/**
 * Gets the plugin ID from an object expression. Without a scope only a
 * literal, a template literal without substitutions or a `+` chain of literals
 * resolves. With a scope, a `const` string and a member of a `const` object
 * resolve too, and with a checker so does anything with a string literal
 * type, such as a `const` imported from another module.
 */
export function getPluginId(
  obj: TSESTree.ObjectExpression,
  scope?: TSESLint.Scope.Scope | null,
  checker?: ts.TypeChecker | null,
  getTSNode?: ((n: TSESTree.Node) => ts.Node | undefined) | null
): string | null {
  const idProperty = getObjectProperties(obj).get('id');
  return idProperty
    ? resolveStaticString(idProperty.value, scope, checker, getTSNode)
    : null;
}

/**
 * Resolves an expression to the string it holds at lint time.
 * `getStaticValue` folds the plain JavaScript part: a literal, a template
 * literal, a `+` chain, a variable that is never reassigned and a member of an
 * object literal that is never mutated, with TypeScript casts stripped. The
 * checker then answers for the TypeScript part: a `const` imported from
 * another module, a namespace member, an enum member or a `static readonly`
 * class property.
 */
export function resolveStaticString(
  node: TSESTree.Node,
  scope?: TSESLint.Scope.Scope | null,
  checker?: ts.TypeChecker | null,
  getTSNode?: ((n: TSESTree.Node) => ts.Node | undefined) | null
): string | null {
  const folded = ASTUtils.getStaticValue(node, scope ?? undefined);
  if (typeof folded?.value === 'string') {
    return folded.value;
  }
  if (!checker || !getTSNode) {
    return null;
  }
  try {
    const tsNode = getTSNode(node);
    if (!tsNode) {
      return null;
    }
    const type = checker.getTypeAtLocation(tsNode);
    return type.isStringLiteral() ? type.value : null;
  } catch {
    return null;
  }
}
export interface TokenEntry {
  name: string;
  node: TSESTree.Node;
}

/**
 * Extracts token names and nodes from an array, including member expressions like JupyterFrontEnd.IPaths
 */
export function extractArrayTokens(
  arrayExpr: TSESTree.ArrayExpression
): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const element of arrayExpr.elements) {
    if (element === null) continue;

    if (element.type === 'Identifier') {
      entries.push({ name: element.name, node: element });
    } else if (element.type === 'MemberExpression') {
      if (
        element.object.type === 'Identifier' &&
        element.property.type === 'Identifier'
      ) {
        entries.push({
          name: `${element.object.name}.${element.property.name}`,
          node: element
        });
      }
    }
  }

  return entries;
}
export function isNullableAnnotation(param: TSESTree.Identifier): boolean {
  if (!param.typeAnnotation) return false;
  const typeNode = param.typeAnnotation.typeAnnotation;
  if (typeNode.type !== 'TSUnionType') return false;
  return typeNode.types.some(
    t => t.type === 'TSNullKeyword' || t.type === 'TSUndefinedKeyword'
  );
}

export function extractParameterType(
  param: TSESTree.Identifier
): string | null {
  if (!param.typeAnnotation) {
    return null;
  }

  const typeNode = param.typeAnnotation.typeAnnotation;

  // Handle TSTypeReference (like JupyterFrontEnd.IPaths)
  if (typeNode.type === 'TSTypeReference') {
    return extractTypeName(typeNode.typeName);
  }

  if (typeNode.type === 'TSUnionType') {
    const nonNullType = typeNode.types.find(t => t.type !== 'TSNullKeyword');
    if (nonNullType && nonNullType.type === 'TSTypeReference') {
      return extractTypeName(nonNullType.typeName);
    }
  }

  return null;
}

/**
 * Recursively extracts the full name from a TSTypeReference typeName node,
 * handling both simple Identifiers and qualified names (TSQualifiedName)
 * e.g. `IType` -> "IType", `JupyterFrontEnd.IPaths` -> "JupyterFrontEnd.IPaths"
 */
function extractTypeName(typeName: TSESTree.EntityName): string | null {
  if (typeName.type === 'Identifier') {
    return typeName.name;
  }

  if (typeName.type === 'TSQualifiedName') {
    const left = extractTypeName(typeName.left);
    const right = typeName.right?.name;
    if (left && right) {
      return `${left}.${right}`;
    }
  }

  return null;
}

const PLUGIN_TYPE_NAMES = ['JupyterFrontEndPlugin', 'ServiceManagerPlugin'];

/**
 * Returns true when a type name refers to a JupyterLab plugin type. Only the
 * last segment is compared, so a namespaced spelling such as
 * `Private.JupyterFrontEndPlugin` matches too.
 */
function isPluginTypeName(name: string | null): boolean {
  if (!name) {
    return false;
  }
  const lastSegment = name.split('.').pop() ?? name;
  return PLUGIN_TYPE_NAMES.includes(lastSegment);
}

/**
 * Returns true when `matches` accepts a type reference found at any depth of
 * a type annotation, so arrays, unions and wrappers such as `Promise<...>` are
 * recognised.
 */
function typeMentions(
  typeNode: TSESTree.TypeNode | undefined | null,
  matches: (reference: TSESTree.TSTypeReference) => boolean,
  depth = 0
): boolean {
  if (!typeNode || depth > 6) {
    return false;
  }

  switch (typeNode.type) {
    case 'TSTypeReference':
      if (matches(typeNode)) {
        return true;
      }
      return (typeNode.typeArguments?.params ?? []).some(param =>
        typeMentions(param, matches, depth + 1)
      );
    case 'TSArrayType':
      return typeMentions(typeNode.elementType, matches, depth + 1);
    case 'TSUnionType':
    case 'TSIntersectionType':
      return typeNode.types.some(type =>
        typeMentions(type, matches, depth + 1)
      );
    case 'TSTupleType':
      return typeNode.elementTypes.some(type =>
        typeMentions(type, matches, depth + 1)
      );
    case 'TSTypeOperator':
    case 'TSRestType':
    case 'TSOptionalType':
      return typeMentions(typeNode.typeAnnotation ?? null, matches, depth + 1);
    case 'TSNamedTupleMember':
      return typeMentions(typeNode.elementType, matches, depth + 1);
    default:
      return false;
  }
}

/**
 * Returns true when a type annotation mentions a JupyterLab plugin type at any
 * depth, so arrays, unions and wrappers such as `Promise<...>` are recognised.
 * Resolves import aliases through the TypeScript checker when it is available.
 */
export function typeMentionsJupyterPlugin(
  typeNode: TSESTree.TypeNode | undefined | null,
  checker?: ts.TypeChecker | null,
  getTSNode?: ((n: TSESTree.Node) => ts.Node | undefined) | null
): boolean {
  return typeMentions(typeNode, reference => {
    if (isPluginTypeName(extractTypeName(reference.typeName))) {
      return true;
    }
    return (
      !!checker &&
      !!getTSNode &&
      reference.typeName.type === 'Identifier' &&
      isPluginTypeName(resolveTypeAlias(reference.typeName, checker, getTSNode))
    );
  });
}

/** The namespace and interface which type a MIME renderer extension entry. */
const MIME_EXTENSION_NAMESPACE = 'IRenderMime';
const MIME_EXTENSION_TYPE_NAME = 'IExtension';

/**
 * Returns true when a type reference is `IRenderMime.IExtension`. Only the
 * qualified spelling counts, because a bare `IExtension` is too common a name
 * to mean anything on its own. The namespace may sit behind a module import
 * (`Interfaces.IRenderMime.IExtension`), and a renamed import such as
 * `import { IRenderMime as RM }` is resolved through the TypeScript checker
 * when it is available.
 */
function isMimeExtensionReference(
  reference: TSESTree.TSTypeReference,
  checker?: ts.TypeChecker | null,
  getTSNode?: ((n: TSESTree.Node) => ts.Node | undefined) | null
): boolean {
  const typeName = reference.typeName;
  if (
    typeName.type !== 'TSQualifiedName' ||
    typeName.right.name !== MIME_EXTENSION_TYPE_NAME
  ) {
    return false;
  }
  const namespace = extractTypeName(typeName.left)?.split('.').pop();
  if (namespace === MIME_EXTENSION_NAMESPACE) {
    return true;
  }
  return (
    !!checker &&
    !!getTSNode &&
    typeName.left.type === 'Identifier' &&
    resolveTypeAlias(typeName.left, checker, getTSNode) ===
      MIME_EXTENSION_NAMESPACE
  );
}

/**
 * Returns true when a type annotation mentions the MIME renderer extension
 * entry type at any depth, with the same wrappers as
 * `typeMentionsJupyterPlugin`. JupyterLab registers each entry as a plugin
 * whose ID is the entry's `id`, so the entry follows the plugin ID convention.
 */
export function typeMentionsMimeExtension(
  typeNode: TSESTree.TypeNode | undefined | null,
  checker?: ts.TypeChecker | null,
  getTSNode?: ((n: TSESTree.Node) => ts.Node | undefined) | null
): boolean {
  return typeMentions(typeNode, reference =>
    isMimeExtensionReference(reference, checker, getTSNode)
  );
}

/**
 * Resolves an identifier through the TypeScript checker to the name it aliases,
 * e.g. `import { JupyterFrontEndPlugin as JFEP }` gives back the original name.
 */
function resolveTypeAlias(
  identifier: TSESTree.Identifier,
  checker: ts.TypeChecker,
  getTSNode: (n: TSESTree.Node) => ts.Node | undefined
): string | null {
  try {
    const tsNode = getTSNode(identifier);
    if (!tsNode) {
      return null;
    }
    const symbol = checker.getSymbolAtLocation(tsNode);
    if (!symbol) {
      return null;
    }
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return resolved.getName();
  } catch {
    return null;
  }
}

const PLUGIN_SHAPE_PROPERTIES = [
  'autoStart',
  'requires',
  'optional',
  'provides',
  'description'
];

/**
 * Returns true when a property holds something callable: a function written in
 * place, or a name referring to one declared elsewhere.
 */
export function isCallableProperty(
  property: TSESTree.Property | undefined
): boolean {
  if (!property) {
    return false;
  }
  switch (property.value.type) {
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'Identifier':
    case 'MemberExpression':
      return true;
    default:
      return false;
  }
}

/**
 * Returns true when an object literal has the shape of a JupyterLab plugin:
 * a string `id`, an `activate` function, and at least one of the properties
 * which only plugins carry. Used for plugin objects written without a type
 * annotation. A caller that resolves the ID itself passes whether one is
 * present, so this check needs no type information.
 */
export function looksLikePluginObject(
  node: TSESTree.ObjectExpression,
  hasId: boolean = getPluginId(node) !== null
): boolean {
  const properties = getObjectProperties(node);

  if (!hasId || !properties.has('id')) {
    return false;
  }

  if (!isCallableProperty(properties.get('activate'))) {
    return false;
  }

  return PLUGIN_SHAPE_PROPERTIES.some(name => properties.has(name));
}

/**
 * Returns true when an object literal has the shape of a MIME renderer
 * extension entry: a string `id` and a `rendererFactory`. Used for entries
 * written without a type annotation. A caller that resolves the ID itself
 * passes whether one is present.
 */
export function looksLikeMimeExtensionObject(
  node: TSESTree.ObjectExpression,
  hasId: boolean = getPluginId(node) !== null
): boolean {
  const properties = getObjectProperties(node);
  return hasId && properties.has('id') && properties.has('rendererFactory');
}
