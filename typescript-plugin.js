exports.create = function(typescript) {
  return {
    name: 'typescript',

    add: function(context, file, options) {
      var js = file.replace(/(?:\.ts)?$/, '.js');
      context.registerTask({
        name: file,
        reads: [file],
        writes: options && options.sourceMap ? [js, js + '.map'] : [js],
        plugins: ['typescript'],
        options: {
          typescript: options || {},
        },
      });
    },

    apply: function(task, done) {
      var options = task.options.typescript;
      var reads = task.reads;
      if (!reads) throw new Error('task ' + JSON.stringify(task.name) + ' is missing the "reads" property');

      var program = typescript.createProgram(reads, options);
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
};
