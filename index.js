#!/usr/bin/env node

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');

function identity(success) {
  return success;
}

function createHash() {
  return crypto.createHash('md5');
}

function createMap() {
  return Object.create(null);
}

function quote(text) {
  return JSON.stringify(text);
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
  if (!count) return done(results);

  promises.forEach(function(promise, i) {
    promise.then(function(result) {
      results[i] = result;
      if (!--count) done(results);
    });
  });
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
    copyFile(cachedFile, file, function(success) {
      promise.resolve(success);
    });
    return promise;
  };
}

function saveFileToCache(directory) {
  return function(file) {
    var promise = createPromise();
    fs.mkdir(directory, function() {
      var cachedFile = path.join(directory, createHash().update(file).digest('hex'));
      copyFile(file, cachedFile, function(success) {
        promise.resolve(success);
      });
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

  function hashTask(task, done) {
    var reads = task.reads;
    var hash = createHash();

    hash.update(task.name);
    hash.update(JSON.stringify(task.plugins));
    hash.update(JSON.stringify(task.options));

    waitForAll(reads.map(hashFile), function(readHashes) {
      for (var i = 0; i < reads.length; i++) {
        hash.update(reads[i]);
        hash.update(readHashes[i]);
      }

      done(hash.digest('hex'));
    });
  }

  function registerPlugin(pluginOptions) {
    var name = pluginOptions.name;

    if (!name) throw new Error('cannot register a plugin without a "name" property');
    if (name in pluginCache) throw new Error('the plugin name ' + quote(name) + ' has already been registered');
    if (!(pluginOptions.apply instanceof Function)) throw new Error('cannot register a plugin without an "apply" method');

    pluginCache[name] = pluginOptions.apply;
  }

  function registerTask(taskOptions) {
    var name = taskOptions.name;

    if (!name) throw new Error('cannot add a task without a "name" property');
    if (name in taskCache) throw new Error('the task name ' + quote(name) + ' has already been registered');

    var task = taskCache[name] = {
      name: name,
      reads: taskOptions.reads || [],
      writes: taskOptions.writes || [],
      before: taskOptions.before || [],
      plugins: taskOptions.plugins || [],
      options: taskOptions.options || {},
    };

    for (var i = 0, writes = task.writes; i < writes.length; i++) {
      var target = writes[i];
      var cache = writesCache[target] || (writesCache[target] = []);
      cache.push(name);
    }
  }

  function scheduleTask(taskName) {
    if (!(taskName in taskCache)) throw new Error('no task named ' + quote(taskName));
    scheduledCache[taskName] = true;
  }

  // Add a dependency for every input file that is written by another task
  function includeReadDependencies(task) {
    var reads = task.reads;
    var before = task.before;

    for (var i = 0; i < reads.length; i++) {
      var readsName = reads[i];
      var names = writesCache[readsName];

      if (names) {
        if (names.length > 1) {
          throw new Error('file ' + quote(readsName) + ' is written by multiple tasks (' + names.map(quote).join(', ') + ')');
        }

        var beforeName = names[0];
        var index = before.indexOf(beforeName);

        if (before < 0) {
          before.push(beforeName);
        }
      }
    }
  }

  function drainQueue(done) {
    var poolSize = contextOptions.poolSize || 1;
    var activeTaskCount = 0;
    var visited = createMap();
    var workmap = createMap();
    var worklist = [];

    function visit(name) {
      if (name in visited) return;
      visited[name] = true;
      var task = taskCache[name];

      if (!task) {
        throw new Error('no task named ' + quote(name));
      }

      includeReadDependencies(task);
      task.before.forEach(visit);

      var work = {
        task: task,
        dependents: [],
        remaining: task.before.length,
      };

      workmap[name] = work;
      worklist.push(work);
    }

    // Add all scheduled tasks and their dependencies to "worklist"
    Object.keys(scheduledCache).forEach(visit);
    scheduledCache = createMap();

    // Make sure each scheduled task knows what depends on it
    for (var i = 0; i < worklist.length; i++) {
      var work = worklist[i];
      var before = work.task.before;
      for (var j = 0; j < before.length; j++) {
        workmap[before[j]].dependents.push(work);
      }
    }

    function runTask(task, done) {
      hashTask(task, function(hash) {
        var taskDirectory = path.join(cacheDirectory, hash);
        var writes = task.writes;

        waitForAll(writes.map(loadFileFromCache(taskDirectory)), function(success) {
          function next() {
            var name = plugins.shift();

            if (name) {
              var plugin = pluginCache[name];
              if (!plugin) throw new Error('no plugin named ' + JSON.stringify(name));

              var once = true;
              plugin(task, function() {
                if (once) {
                  once = false;
                  next();
                }
              });
            }

            else {
              waitForAll(writes.map(saveFileToCache(taskDirectory)), function(successes) {
                successes.forEach(function(success, i) {
                  if (!success) console.log('[' + task.name + '] missing expected output ' + JSON.stringify(writes[i]));
                });

                console.log('[' + task.name + '] done');
                done();
              });
            }
          }

          if (success.every(identity)) {
            console.log('[' + task.name + '] ' + (writes.length ? 'skip' : 'done'));
            done();
          }

          else {
            var plugins = task.plugins.slice();
            next();
          }
        });
      });
    }

    function scanForMoreWork() {
      for (var i = worklist.length - 1; i >= 0; i--) {
        if (!worklist[i].remaining) {
          return worklist.splice(i, 1)[0];
        }
      }
      return null;
    }

    function runMoreTasks() {
      while (activeTaskCount < poolSize) {
        var work = scanForMoreWork();
        if (!work) break;
        activeTaskCount++;
        (function(work) {
          runTask(work.task, function() {
            var dependents = work.dependents;
            for (var i = 0; i < dependents.length; i++) {
              dependents[i].remaining--;
            }
            activeTaskCount--;
            runMoreTasks();
          });
        })(work);
      }

      // Stop when we've reached a fixed point
      if (activeTaskCount === 0) {
        if (worklist.length > 0) {
          console.log('warning: tasks left over (are there circular dependencies?): ' + worklist.map(function(work) {
            return work.task.name;
          }).join(', '));
        }

        if (done) {
          done();
        }
      }
    }

    runMoreTasks();
  }

  if (!contextOptions.cacheDirectory) {
    throw new Error('cannot create a context without a "cacheDirectory" property');
  }
  var cacheDirectory = contextOptions.cacheDirectory;

  try {
    fs.mkdirSync(cacheDirectory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  var pluginCache = createMap();
  var taskCache = createMap();
  var writesCache = createMap();
  var hashCache = createMap();
  var scheduledCache = createMap();

  return {
    defaultPlugins: {
      typescript: require('./typescript-plugin'),
      coffeescript: require('./coffeescript-plugin'),
    },

    registerPlugin: registerPlugin,
    registerTask: registerTask,
    scheduleTask: scheduleTask,
    drainQueue: drainQueue,
  };
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
    context.scheduleTask(task);
  });
  context.drainQueue();
}

exports.main = main;

if (require.main === module) {
  main();
}
