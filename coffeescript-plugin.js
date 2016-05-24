exports.create = function(coffeescript) {
  return {
    name: 'coffeescript',

    add: function(context, file, options) {
      var js = file.replace(/(?:\.coffee)?$/, '.js');
      context.registerTask({
        name: file,
        reads: [file],
        writes: options && options.sourceMap ? [js, js + '.map'] : [js],
        plugins: ['coffeescript'],
        options: {
          coffeescript: options || {},
        },
      });
    },

    apply: function(task, done) {
      var fs = require('fs');
      var options = task.options.coffeescript;
      var reads = task.reads;
      if (!reads) throw new Error('task ' + JSON.stringify(task.name) + ' is missing the "reads" property');

      function next() {
        var item = queue.shift();
        if (item) item();
        else done();
      }

      var queue = reads.map(function(file) {
        fs.readFile(file, 'utf8', function(error, data) {
          if (error) throw new Error(error);
          var result = coffeescript.compile(data, options);
          var target = file.replace(/(?:\.coffee)?$/, '.js');

          if (options.sourceMap) {
            fs.writeFile(target, result.js + '\n//# sourceMappingURL=' + target + '.map\n', function() {
              fs.writeFile(target + '.map', result.v3SourceMap + '\n', next);
            });
          }

          else {
            fs.writeFile(target, result, next);
          }
        });
      });

      next();
    },
  };
};
