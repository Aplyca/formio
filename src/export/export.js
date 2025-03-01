'use strict';

const exporters = require('.');
const _ = require('lodash');
const through = require('through');
const _url = require('url');
const ResourceFactory = require('resourcejs');
const debug = require('debug')('formio:error');

module.exports = (router) => {
  const hook = require('../util/hook')(router.formio);
  /* eslint-disable new-cap */
  const resource = ResourceFactory(
    router,
    '/form/:formId/export',
    'export',
    router.formio.mongoose.model('submission'),
    {
      convertIds: /(^|\.)(_id|form|owner)$/
    }
  );
  /* eslint-enable new-cap */

  // Mount the export endpoint using the url.
  router.get('/form/:formId/export', (req, res, next) => {
    if (!_.has(req, 'token') || !_.has(req, 'token.user._id')) {
      return res.sendStatus(400);
    }

    // Get the export format.
    const format = (req.query && req.query.format)
      ? req.query.format.toLowerCase()
      : 'json';

    // Handle unknown formats.
    if (!exporters.hasOwnProperty(format)) {
      return res.status(400).send('Unknown format');
    }

    // Load the form.
    router.formio.cache.loadCurrentForm(req, (err, form) => {
      if (err) {
        return res.sendStatus(401);
      }
      if (!form) {
        return res.sendStatus(404);
      }

      // Allow them to provide a query.
      let query = {};
      if (req.headers.hasOwnProperty('x-query')) {
        try {
          query = JSON.parse(req.headers['x-query']);
        }
        catch (e) {
          debug(e);
          router.formio.util.log(e);
        }
      }
      else {
        query = resource.getFindQuery(req, {
          queryFilter: true
        });
      }

      // Enforce the form.
      query.form = form._id;

      // Only show non-deleted items unless specified
      if (query && !query.hasOwnProperty('deleted')) {
        query.deleted = {$eq: null};
      }

      // Create the exporter.
      const exporter = new exporters[format](form, req, res);

      // Allow an alter of the export logic.
      hook.alter('export', req, query, form, exporter, (err) => {
        if (err) {
          return res.status(400).send(err.message);
        }

        // Initialize the exporter.
        exporter.init()
          .then(() => {
            const addUrl = (data) => {
              _.each(data, (field) => {
                if (field && field._id) {
                  // Add url property for resource fields
                  const fieldUrl = hook.alter('fieldUrl', `/form/${field.form}/submission/${field._id}`, form, field);
                  const apiHost = router.formio.config.apiHost || router.formio.config.host;
                  field.url = _url.resolve(apiHost, fieldUrl);
                  // Recurse for nested resources
                  addUrl(field.data);
                }
              });
            };

            // Skip this owner filter, if the user is the admin or owner.
            if (req.skipOwnerFilter !== true && req.isAdmin !== true) {
              // The default ownerFilter query.
              query.owner = router.formio.util.ObjectId(req.token.user._id);
            }

            // Create the query stream.
            const submissionModel = req.submissionModel || router.formio.resources.submission.model;
            const cursor = submissionModel.find(hook.alter('submissionQuery', query, req)).lean().cursor();
            const stream = cursor.pipe(through(function(row) {
              addUrl(row.data);
              router.formio.util.removeProtectedFields(form, 'export', row);

              this.queue(row);
            }), {end: false});

            // When the DB cursor ends, allow the output stream a tick to perform the last write,
            // then manually end it by pushing a null item to the output stream's queue
            cursor.on('end', () => process.nextTick(() => stream.queue(null)));

            // Create the stream.
            return exporter.stream(stream);
          })
          .catch((error) => {
            // Send the error.
            res.status(400).send(error);
          });
      });
    });
  });
};
