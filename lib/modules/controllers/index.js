'use strict';

exports = module.exports = Controllers;

var Controller = require('./controller');
var utils = require('./../../helpers/utils');

var util = require('util');
var path = require('path');
var debug = require('debug')('fire:controllers');

var Q = require('q');

/**
 * The Controllers module.
 *
 * @param {App} app The app initializing this module.
 * @implements Resources
 * @constructor
 */
function Controllers(app) {
	// When the app is disabled, we do not have an express instance.
	if(app.express) {
		var keys = ['1038641b2d8e106ea60850034b43d7a9'];

		if(process.env.SESSION_KEYS) {
			keys = process.env.SESSION_KEYS.split(',');
		}
		else {
			if(!process.env.NODE_ENV || process.env.NODE_ENV != 'development' && process.env.NODE_ENV != 'test') {
				console.log('WARNING: Specify SESSION_KEYS in your .env to properly configure cookie session.');
			}
		}

		app.express.use(require('cookie-session')({
			keys: keys,
			name: 'sid'
		}));
		app.express.use(require('body-parser')());
	}

	this.app 	= app;
	this._cache = [];
	this._controllers = {};
}

/**
* Sets up a controller.
*
* The `controllerConstructor` gets inherited by Controller and the constructor gets added to the system so routes can be generated and additional code can be generated.
*
* Please note: the constructor itself, is __never__ executed in the server-context. Instead, the constructor is passed to angular's controller method and a controller is created on the client-context.
*
* ```js
* function MyController($scope) {
* 	console.log(MyController);
* }
* app.controller(MyController);
*
* MyController.prototype.view = function() {
* 	return this.template('index');
* };
* ```
*
* The Bridge module is responsible for generating the client-context controller. This Controllers module checks the controllerConstructor's prototype and creates any routes.
*
* @param  {Constructor} controllerConstructor The named controller constructor.
*/
Controllers.prototype.controller = function(controllerConstructor) {
	util.inherits(controllerConstructor, Controller);

	// We delay because when app.controller(MyController) is called, we have to wait before the complete prototype is set.
	var self = this;
	setImmediate(function() {
		self.addControllerConstructor(controllerConstructor);
	});
};

Controllers.prototype.ignoreDisabled = true;

/**
 * Convenience method to loop over all controllers.
 *
 * @param {Function} callback(controllerConstructor) The callback function is invoked for every controller.
 */
Controllers.prototype.forEach = function(callback) {
	var controllerNames = Object.keys(this._controllers);
	for(var i = 0, il = controllerNames.length; i < il; i++) {
		var controllerConstructor = this._controllers[controllerNames[i]];
		callback(controllerConstructor);
	}
};

/**
 * Loads all files in the `controllers/` directory and sets up all already loaded controllers.
 *
 * Setup is invoked by the app when it's starting up.
 *
 * @param  {String} basePath The root path of the project.
 * @return {Promise}
 */
Controllers.prototype.setup = function(basePath) {
	var defer = Q.defer();

	debug('Controllers#setup');
	
	// Everything gets added in the cache.
	utils.requireDirSync(path.join(basePath, 'controllers'));

	// We delay the execution as the prototype isn't fully declared yet.
	// See Models#setup for more details.
	var self = this;
	setImmediate(function() {
		// We get the cache and invalidate it.
		var cache = self._cache;
		self._cache = null;

		cache.forEach(function(controllerConstructor) {
			self.loadControllerConstructor(controllerConstructor, null);
		});

		debug('~Controllers#setup');
		defer.resolve();
	});

	return defer.promise;
};

/**
 * Adds `controllerConstructor` to the load queue, or loads the constructor if setup already finished.
 *
 * If the controllers are already loaded (the setup is finished) immediately loads a controller. Because the constructor's prototype might not be completely set yet, this method delays execution with a setImmediate.
 *
 * @param {Constructor} controllerConstructor The controller constructor to be loaded.
 */
Controllers.prototype.addControllerConstructor = function(controllerConstructor) {
	debug('addController ' + controllerConstructor.name);

	if(this._cache) {
		this._cache.push(controllerConstructor);
	}
	else {
		this.loadControllerConstructor(controllerConstructor, null);
	}
};

/**
 * Loads the controller and creates the routes based on the controller's methods.
 *
 * There is no separate routing table, but the router creates the routes based on the controllers' methods. For more information on route, see Router.
 *
 * @param {Constructor} controllerConstructor
 * @param {String} fullPath              The path to the constructor's file
 */
Controllers.prototype.loadControllerConstructor = function(controllerConstructor, fullPath) {
	debug('loadControllerConstructor `' + controllerConstructor.name + '`.');

	// Now we add the controller class (it's actually a constructor) to the controllers.
	// This will build the routes to the controller.

	if(!(controllerConstructor.prototype instanceof Controller)) {
		throw new Error('Controller in `' + fullPath + '` is not an instance of Controller. Did you call app.controller(...) on your controller?');
	}

	var router = controllerConstructor.prototype.getRouter(controllerConstructor, fullPath);
	router.delegate = this;
	router.createRoutes();

	this._controllers[controllerConstructor.name] = controllerConstructor;
};

/**
 * This is a route delegate method and is invoked whenever the router creates a route for a controller's method.
 *
 * If the route is a view route, two GET routes are created. A method is considered a view route if the method's name starts with view and returns a Template instance.
 * 		1. A route to the template returned by the view method.
 * 		2. A route to the view—returning the application's main view.
 *
 * Consider the following view method:
 *
 * ```js
 * TestController.prototype.view = function() {
 * 	return this.template('index.jade');
 * };
 * ```
 *
 * This view method would produce a route to `GET /` returning the app's view and a route to `GET /templates/index.jade` returning the compiled template.
 *
 * The app's default view is view.jade and is used as main template in angular. The view should contain the ngApp and ngView directives.
 *
 * If the route is not a view route, a controller route is created.
 *
 * When a request matches the route, roughly the following happens:
 *
 * 	1. A controller is allocated and initialized.
 * 	2. Controller#configure() is called with the NODE_ENV.
 * 	3. Controller#before is called.
 * 	4. The controller's method the route is linked to is called.
 * 	5. The return value of the controller's method is send as JSON to the client.
 * 	6. Controller#after is called.
 *
 * If during any of the steps an error occurs, an error is send with a proper HTTP status code.
 *
 * @param {Route} route The route to be added.
 */
Controllers.prototype.addRoute = function(route) {
	if(!this.app.express) {
		return;
	}

	var self = this;

	// If this is a view route, simply add it to the views instead.
	if(route.isView) {
		debug('addTemplate ' + route.templatePath);

		this.app.express.get(route.templatePath, function(request, response) {
			// TODO: Include global options from ... somewhere.
			var html = self.app.templates.template(route.template.name);
			if(!html) {
				response.status(404).send();
			}
			else {
				response.status(200).send(html);
			}
		});

		debug('addView ' + route.path);

		this.app.express.get(route.path, function parseView(request, response) {
			var options = {
				_fire: {
					appName: self.app.name
				},
				stylesheets: self.app.options.stylesheets || [],
				scripts: self.app.options.scripts || []
			};

			var html = self.app.templates.template('view.jade');
			if(html) {
				response.status(200).send(html);
			}
			else {
				response.render(path.join(__dirname, 'templates', 'view.jade'), options, function renderView(error, text) {
					if(error) {
						throw error;
					}
					else {
						response.status(200).send(text);
					}
				});
			}
		});
	}
	else {
		debug('addRoute ' + route.verb + ' ' + route.path);

		this.app.express[route.verb](route.path, function parseConnection(request, response) {
			debug('parseConnection ' + request.url);

			// TODO: Cache this instance and do not allocate a new instance on every request.
			var TemporaryController = function __TemporaryController() {};
			util.inherits(TemporaryController, route.controllerConstructor);

			var controller = new TemporaryController();
			Controller.call(controller, self.app.models, request, response);
			controller.configure(process.env.NODE_ENV || 'development');

			Q.when(controller.before())
				.then(function() {
					return route.method.apply(controller, route.argumentNames.map(function(argumentName) {
						if(argumentName[0] == '$' && argumentName.length > 1) {
							return request.params[argumentName.substring(1)];
						}
						else {
							return request.param(argumentName);
						}
					}));
				})
				.then(function(result) {
					// TODO: Add another hook to "transform" the result.
					// TODO: Return a promise in this scope, resolve it later on (in callbacks/stream).
					if(result) {
						response.json(result);
					}
					else {
						response.status(404).send();
					}
				})
				.then(function() {
					return controller.after();
				})
				.catch(function(error) {
					debug(error);

					// TODO: This should go through Route#sendResponse instead.

					response.status(error.status || 500).send({
						error: error.message
					});
				})
				.done();
		});
	}
};