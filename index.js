#!/usr/bin/env node

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');

function createHash() {
  return crypto.createHash('md5');
}

function createPromise() {
  var isResolved = false;
  var callbacks = [];
  var cached;
  var result = {
    then: function(callback) {
      if (isResolved) callback(cached);
      else callbacks.push(callback);
    },
    resolve: function(value) {
      if (isResolved) return;
      isResolved = true;
      cached = value;
      for (var i = 0; i < callbacks.length; i++) {
        callbacks[i](value);
      }
    },
  };
  return result;
}

function waitForAll(promises, done) {
  var count = promises.length;
  var results = new Array(count);
  promises.forEach(function(promise, i) {
    promise.then(function(result) {
      results[i] = result;
      if (!--count) done(results);
    });
  });
  if (!count) done(results);
}

function drainQueue(queue, done) {
  function next() {
    var item = queue.shift();
    if (item) {
      item(next);
    } else if (done) {
      var once = done;
      done = null;
      once();
    }
  }
  next();
}

function copyFile(from, to, done) {
  fs.exists(from, function(exists) {
    if (!exists) return done(false);
    var reading = fs.createReadStream(from);
    var writing = fs.createWriteStream(to);
    writing.on('finish', function() { done(true); });
    reading.pipe(writing);
  });
}

function loadFileFromCache(directory) {
  return function(file) {
    var cachedFile = path.join(directory, createHash().update(file).digest('hex'));
    var promise = createPromise();
    copyFile(cachedFile, file, function(success) { promise.resolve(success); });
    return promise;
  };
}

function saveFileToCache(directory) {
  return function(file) {
    var promise = createPromise();
    fs.mkdir(directory, function() {
      var cachedFile = path.join(directory, createHash().update(file).digest('hex'));
      copyFile(file, cachedFile, function(success) { promise.resolve(success); });
    });
    return promise;
  };
}

function createContext(contextOptions) {
  function hashFile(file) {
    var promise = hashCache[file];
    if (!promise) {
      promise = createPromise();
      hashCache[file] = promise;
      var stream = fs.createReadStream(file);
      var hash = createHash();
      stream.on('data', function(chunk) { hash.update(chunk); });
      stream.on('end', function() { promise.resolve(hash.digest('hex')); });
      stream.on('error', function() { promise.resolve(null); });
    }
    return promise;
  }

  if (!contextOptions.cacheDirectory) throw new Error('cannot create a context without a "cacheDirectory" property');
  var cacheDirectory = contextOptions.cacheDirectory;

  try {
    fs.mkdirSync(cacheDirectory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  var pluginCache = Object.create(null);
  var readsCache = Object.create(null);
  var writesCache = Object.create(null);
  var taskCache = Object.create(null);
  var hashCache = Object.create(null);

  var context = {
    defaultPlugins: {
      typescript: require('./typescript-plugin'),
      coffeescript: require('./coffeescript-plugin'),
    },

    addPlugin: function(pluginOptions) {
      var name = pluginOptions.name;
      if (!name) throw new Error('cannot add a plugin without a "name" property');
      if (name in pluginCache) throw new Error('the plugin name ' + JSON.stringify(name) + ' has already been used');
      if (!(pluginOptions.apply instanceof Function)) throw new Error('cannot add a plugin without an "apply" method');
      pluginCache[name] = pluginOptions;
    },

    addTask: function(taskOptions) {
      var name = taskOptions.name;
      var reads = taskOptions.reads;
      var writes = taskOptions.writes;

      if (!name) throw new Error('cannot add a task without a "name" property');
      if (name in taskCache) throw new Error('the task name ' + JSON.stringify(name) + ' has already been used');
      taskCache[name] = taskOptions;

      if (reads) {
        for (var i = 0; i < reads.length; i++) {
          var source = reads[i];
          var cache = readsCache[source] || (readsCache[source] = {tasks: []});
          cache.tasks.push(name);
        }
      }

      if (writes) {
        for (var i = 0; i < writes.length; i++) {
          var target = writes[i];
          var cache = writesCache[target] || (writesCache[target] = {tasks: []});
          cache.tasks.push(name);
        }
      }
    },

    runTask: function(name, done) {
      var task = taskCache[name];
      if (!task) throw new Error('no task named ' + JSON.stringify(name));

      var reads = task.reads || [];
      var writes = task.writes || [];
      var before = task.before || [];
      var after = task.after || [];
      var plugins = task.plugins || [];
      var options = task.options || {};
      var beforeQueue = before.map(function(name) {
        return function(next) { context.runTask(name, next); };
      });

      drainQueue(beforeQueue, function() {
        var hash = createHash();
        hash.update(task.name);
        hash.update(JSON.stringify(options));
        hash.update(JSON.stringify(plugins));

        waitForAll(reads.map(hashFile), function(readHashes) {
          for (var i = 0; i < reads.length; i++) {
            hash.update(reads[i]);
            hash.update(readHashes[i]);
          }

          var taskDirectory = path.join(cacheDirectory, hash.digest('hex'));

          waitForAll(writes.map(loadFileFromCache(taskDirectory)), function(successes) {
            var success = successes.every(function(status) { return status; });
            var afterQueue = after.map(function(name) {
              return function(next) { context.runTask(name, next); };
            });

            if (success) {
              drainQueue(afterQueue, function() {
                console.log('[' + name + '] skip');
                if (done) done();
              });
            }

            else {
              var pluginQueue = plugins.map(function(name) {
                var plugin = pluginCache[name];
                if (!plugin) throw new Error('no plugin named ' + JSON.stringify(name));
                return function(next) {
                  plugin.apply(task, next);
                };
              });

              drainQueue(pluginQueue, function() {
                waitForAll(writes.map(saveFileToCache(taskDirectory)), function(successes) {
                  successes.forEach(function(success, i) {
                    if (!success) console.log('[' + name + '] missing expected output ' + JSON.stringify(writes[i]));
                  });
                  drainQueue(afterQueue, function() {
                    console.log('[' + name + '] done');
                    if (done) done();
                  });
                });
              });
            }
          });
        });
      });
    },
  };

  return context;
}

exports.context = createContext;

function main() {
  var cwd = process.cwd();
  var file = path.join(cwd, 'hashbuild.js');
  var context = createContext({
    cacheDirectory: path.join(cwd, '.hashbuild'),
  });
  require(file)(context);
  var tasks = process.argv.length > 2 ? process.argv.slice(2) : ['default'];
  tasks.forEach(function(task) {
    context.runTask(task);
  });
}

exports.main = main;

if (require.main === module) {
  main();
}
