'use strict';

var compression = require('compression');
var debug       = require('debug')('apiembed');
var express     = require('express');
var httpsnippet = require('httpsnippet');
var morgan      = require('morgan');
var unirest     = require('unirest');

var availableTargets = httpsnippet.availableTargets().reduce(function (targets, target) {
  if (target.clients) {
    targets[target.key] = target.clients.reduce(function (clients, client) {
      clients[client.key] = false;
      return clients;
    }, {});
  } else {
    targets[target.key] = false;
  }

  return targets;
}, {});

var namedTargets = httpsnippet.availableTargets().reduce(function (targets, target) {
  if (target.clients) {
    targets[target.key] = target;

    targets[target.key].clients = target.clients.reduce(function (clients, client) {
      clients[client.key] = client;
      return clients;
    }, {});
  } else {
    targets[target.key] = target;
  }

  return targets;
}, {});

var APIError = function  (code, message) {
  this.name = 'APIError';
  this.code = code || 500;
  this.message = message || 'Oops, something went wrong!';
};

APIError.prototype = Error.prototype;

// load .env
require('dotenv').load();

// express setup
var app = express();
app.set('view engine', 'jade');
app.disable('x-powered-by');

if (!process.env.NOCACHE) {
  app.enable('view cache');
}

// logging
app.use(morgan('dev'));

// add 3rd party middlewares
app.use(compression());

// useful to get info in the view
app.locals.httpsnippet = httpsnippet;
app.locals.namedTargets = namedTargets;

// enable CORS
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// static middleware does not work here
app.use('/favicon.ico', function (req, res) {
  res.sendFile(__dirname + '/static/favicon.ico');
});

// static middleware does not work here
app.use('/targets', function (req, res) {
  res.json(httpsnippet.availableTargets());
});

app.get('/', function (req, res, next) {
  var source = decodeURIComponent(req.query.source);
  var targets = req.query.targets || 'all';

  if (!source) {
    return next(new APIError(400, 'Invalid input'));
  }

  debug('received request for source: %s & targets: %s', source, targets);

  // parse the requested targets
  // TODO this needs optimization
  var requestedTargets = targets.split(',').reduce(function (requested, part) {
    var i = part.split(':');

    var target = i[0] || 'all';
    var client = i[1] || 'all';

    // all targets
    if (target === 'all') {
      // set all members to true
      return Object.keys(availableTargets).reduce(function (requested, target) {
        if (typeof availableTargets[target] === 'object') {
          requested[target] = Object.keys(availableTargets[target]).reduce(function (clients, client) {
            clients[client] = true;
            return clients;
          }, {});
        } else {
          requested[target] = true;
        }

        return requested;
      }, {});
    }

    // all clients?
    if (availableTargets.hasOwnProperty(target)) {
      if (typeof availableTargets[target] === 'object') {
        if (client === 'all') {
          requested[target] = Object.keys(availableTargets[target]).reduce(function (clients, client) {
            clients[client] = true;
            return clients;
          }, {});
        } else {
          if (availableTargets[target].hasOwnProperty(client)) {
            requested[target] = requested[target] ? requested[target] : {};
            requested[target][client] = true;
          }
        }
      } else {
        requested[target] = true;
      }

      return requested;

    }

    return requested;
  }, {});

  unirest.get(source)
    .headers({'Accept': 'application/json'})
    .end(function (response) {
      if (response.error) {
        debug('failed to load source over http: %s %s', response.code || response.error.code , response.status || response.error.message);

        return next(new APIError(400, 'Could not load JSON source'));
      }

      var snippet;
      var output = {};

      if (typeof response.body !== 'object') {
        try {
          response.body = JSON.parse(response.body);
        } catch (err) {
          debug('failed to parse content of %s, with error: %s', source, err.message);

          return next(new APIError(400, 'Invalid JSON source'));
        }
      }

      try {
        snippet = new httpsnippet(response.body);
      } catch (err) {
        debug('failed to generate snippet object: %s', err.message);

        return next(new APIError(400, err));
      }

      Object.keys(requestedTargets).map(function (target) {
        if (typeof requestedTargets[target] === 'object') {
          output[target] = {};

          return Object.keys(requestedTargets[target]).map(function (client) {
            output[target][client] = snippet.convert(target, client);
          });
        }

        output[target] = snippet.convert(target);
      });


      if (Object.keys(output).length === 0) {
        debug('no matching targets found');

        return next(new APIError(400, 'Invalid Targets'));
      }

      res.render('main', {
        output: output
      });

      res.end();
    });
});

// error handler
app.use(function errorHandler(error, req, res, next) {
  if (error.code === 400) {
    error.message += ', please review the <a href="/" target="_top">documentation</a> and try again';
  }

  // never show a 40x
  res.status(200);
  res.render('error', error);
});

app.listen(process.env.PORT || process.env.npm_package_config_port);
