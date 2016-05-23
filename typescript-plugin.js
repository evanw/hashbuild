module.exports = {
  name: 'typescript',

  apply: function(task, done) {
    var typescript = require('typescript');
    var options = task.options;
    var reads = task.reads;
    if (!reads) throw new Error('task ' + JSON.stringify(task.name) + ' is missing the "reads" property');

    var program = typescript.createProgram(reads, options || {});
    var result = program.emit();
    var diagnostics = typescript.getPreEmitDiagnostics(program).concat(result.diagnostics);
    var syntaxErrors = diagnostics.filter(function(diagnostic) { return diagnostic.code < 2000; });

    // Only stop the build if there were syntax errors (type errors still generate valid JavaScript output)
    if (result.emitSkipped || syntaxErrors.length) {
      throw new Error(['Failed to compile ' + reads.concat(options).map(JSON.stringify).join(' ')].concat(syntaxErrors.map(function(diagnostic) {
        var start = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        var message = typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        return diagnostic.file.fileName + ':' + (start.line + 1) + ':' + (start.character + 1) + ': ' + message;
      })).join('\n'));
    }

    done();
  },
};
