module.exports = {
  name: 'coffeescript',

  apply: function(task, done) {
    var coffeescript = require('coffee-script');
    var fs = require('fs');
    var options = task.options || {};
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
          fs.writeFile(target, result.js + '//# sourceMappingURL=' + target + '.map\n', function() {
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
