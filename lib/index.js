const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const gql = require('graphql-tag');
const { print } = require('graphql/language/printer');

const IMPORT_REGEXP = /^#\s*(import|include|require)\s*(\'|\")(.+?)(\'|\")/;
const EXTENSIONS = ['.gql', '.graphql'];

function getFile(cwd, filePath, options, tryExts) {
  tryExts = (tryExts || options.extensions || []).slice(0);
  if (!tryExts) return;
  const filename = path.resolve(cwd, filePath);
  if (fs.existsSync(filename)) return filename;
  if (tryExts.length < 1) return;
  return getFile(cwd, filePath + tryExts.shift(), options, tryExts);
}

function readFile(cwd, filePath, options) {
  const filename = getFile(cwd, filePath, options);
  if (!filename) return;
  return {
    filename: filename,
    context: path.dirname(filename),
    content: fs.readFileSync(filename, 'utf8')
  };
}

function parse(cwd, source, options) {
  const contents = [source];
  const lines = source.split('\n');
  lines.forEach(line => {
    line = line.trim();
    const matchInfo = IMPORT_REGEXP.exec(line);
    const filePath = matchInfo && matchInfo[3];
    if (!filePath) return;
    const fileInfo = readFile(cwd, filePath, options);
    if (!fileInfo) return;
    this.addDependency(fileInfo.filename);
    const includes = parse.call(
      this, fileInfo.context, fileInfo.content, options
    );
    contents.push(...includes);
  });
  return _.uniq(contents);
}

const collect = (ast) => {
  const collect = {
    fragment: {},
    query: {},
    mutation: {},
  };

  ast.definitions.forEach(block => {
    switch (block.kind) {
      case 'FragmentDefinition':
        collect.fragment[block.name.value] = block;
        break;
      case 'OperationDefinition':
        collect[block.operation][block.name.value] = block;
        break;
      default:
        break;
    }
  });

  return collect;
};

const getDepFragments = (block, fragments) => {
  const deps = [];

  const loop = selection => {
    if (!selection) {
      return;
    }
    if (selection.kind === 'FragmentSpread') {
      deps.push(fragments[selection.name.value]);
      loop(fragments[selection.name.value]);
      return;
    }
    if (
      selection.selectionSet &&
      selection.selectionSet.selections &&
      Array.isArray(selection.selectionSet.selections)
    ) {
      selection.selectionSet.selections.forEach(loop);
    }
  };

  loop(block);

  return deps;

};

function getOptions(ctx) {
  const options = ctx.loaders[ctx.loaderIndex].options || {};
  return _.defaults(options, {
    extensions: EXTENSIONS,
    string: false,
    debug: false,
    url: '/graphql',
    request: require.resolve('./request')
  });
}

function loader(source) {
  this.cacheable();
  const options = getOptions(this);
  const result = parse.call(this, this.context, source, options);
  const query = result.join('\n');
  const ast = gql(query);

  const col = collect(ast);

  const blocks = {};
  const debugBlock = {};

  let length = 0;
  _.each(Object.assign({}, col.query, col.mutation), (block, key) => {
    length++;
    const fragmentTexts = print(getDepFragments(block, col.fragment));
    let blockTexts = print(block);
    fragmentTexts.forEach(fragment => {
      const regex = /fragment\s+(\S+)\s+on\s\S+\s+\{/;
      // 第二个值是fragment的名称
      const [_, name] = fragment.match(regex);
      // 获取fragment的主体，例：去掉"fragment test2 on XXX{"和最后一个"}"就是fragment的主体
      const fragmentBody = fragment.substring(0, fragment.length - 1).replace(regex, '');
      // 将 ...fragmentName替换成 fragment的主体
      blockTexts = blockTexts.replace(`...${name}`, fragmentBody);
    });
    blocks[key] = blockTexts;
    if (options.debug) {
      debugBlock[key] = blockTexts;
    }
  });

  if (options.string) {
    return `module.exports = ${JSON.stringify(length === 1 ? Object.values(blocks).pop() : blocks)}`;
  }



  let output = `
var blocks = ${JSON.stringify(blocks)}
var wrap = function(block, name){
  var req = function(variables, options) {
    var data = { 
      operationName: name,
      query: block, 
      variables: variables
    };
    return window.gajax(data,options)
  }
  req.raw = block
  req.type = ~block.indexOf('mutation ') ? 'mutation' : 'query'
  return req
}
var exportBlock = {} 
var length = 0
for(var key in blocks) {
  length++
  exportBlock[key] = wrap(blocks[key], key)
}
exportBlock._raw = Object.values(blocks)
exportBlock._debug = ${options.debug ? JSON.stringify(debugBlock) : false}
module.exports = exportBlock;
`;
  return output;
}

module.exports = loader;