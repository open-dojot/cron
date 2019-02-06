'use strict';

const express = require('express');
const expressValidator = require('express-validator')
const { body, oneOf, validationResult } = require('express-validator/check');
const authChecker = require('./auth');
const timeParser = require('cron-parser');
const cron = require('./cron');
const config = require('./config');

// Http server
const app = express();
app.use(express.json());
app.use(expressValidator());
// all APIs should be invoked with valid dojot issued JWT tokens
app.use(authChecker.authParse);
app.use(authChecker.authEnforce);

// Error Messages
const errors = {
  // internal server error
  internal : { error: 1, message: "Something went wrong. Try again later."},
  notfound:  { error: 2, message: "Resource not found."},

  // invalid parameters
  invalid :  {
    // global
    time:        {error: 101, message: 'Invalid cron time.'},
    timezone:    {error: 102, message: 'Invalid timezone.'},
    name:        {error: 103, message: 'Invalide name.'},
    description: {error: 104, message: 'Invalid description.'},
    action:      {error: 105, message: 'Invalid job action.'},
    // http
    http: {
      method:    {error: 111, message: '(http action) Invalid method.'},
      headers:   {error: 112, message: '(http action) Invalid headers.'},
      url:       {error: 113, message: '(http action) Invalid http url.'},
      criterion: {error: 114, message: '(http action) Invalid success criterion.'},
      sregex:    {error: 115, message: '(http action) Invalid regular expression for criterion 2.'},
      fregex:    {error: 116, message: '(http action) Invalid regular expression for criterion 3.'},
      body:      {error: 117, message: '(http action) Invalid body'}
    },      
    // data broker
    broker: {
      subject:   {error: 121, message: '(broker action) Invalid subject.'},
      message:   {error: 122, message: '(broker action) Invalid message.'}
    },
    // function
    jscode: {
      snippet:   {error: 131, message: 'Invalid code snippet.'}
    }
  }
};

// Cron Manager
var cronManager = null; //initialized at init()

//
// REST API
//

// POST /cron/v1/jobs
app.post('/cron/v1/jobs',[
  // cron time validation
  body('time', errors.invalid.time)
  .custom(value => {
    try {
        const isValid = timeParser.parseString(value);
        if (typeof isValid.error != 'undefined' && isValid.error.length > 0) {
          console.debug(`Couldn't parse cron time (error = ${isValid.error})`);
          return false;
        }
      }
      catch(ex) {
        console.debug(`Couldn't parse cron time (exception = ${ex})`);
        return false;
      }

      return true; 
    }),
  
  // timezone validation
  body('timezone', errors.invalid.timezone)
  .optional().isString(),
  
  // name validation
  body('name', errors.invalid.name)
  .optional().isString().isLength({max: 128}),
  
  // description validation
  body('description', errors.invalid.description)
  .optional().isString().isLength({max: 1024}),
  
  // endpoints validation
  oneOf([
    
    // http
    [
      //http-method
      body('http.method', errors.invalid.http.method).isIn(
        [
         'post', 'POST', 'get', 'GET', 'put', 'PUT', 'delete',  'DELETE',
         'head', 'HEAD', 'patch', 'PATCH', 'connect', 'CONNECT',
         'options', 'OPTIONS', 'trace', 'TRACE'
        ]),

      //http-url
      body('http.url', errors.invalid.http.url)
      .custom(value => {
        // allowed base URLs
        for(let baseURL of config.cronManager.http.allowedBaseURLs) {
          if(value.startsWith(baseURL)) {
            return true;
          }
        }
        return false;
      }),
      
      //http-headers
       body('http.headers', errors.invalid.http.headers)
       .optional().custom(value => {
         if (!value) return true;
          try {
            // json
            let headers = JSON.stringify(value);
            
            // max:2048
            if(headers.length <= 2048) {
              return true;
            }
            else {
              console.debug(`HTTP headers exceeded maximum length (${headers.length} > 2048)`);
            }
          }
          catch(ex) {
            console.debug(`Couldn't parse headers for http-action (exception = ${ex})`);
            return false;
          }
          return false;
       }),
      
       //http-criterion
       body('http.criterion', errors.invalid.http.criterion)
       .optional().isInt({min: 1, max:3}),
      
       //http-sregex
       body('http.sregex', errors.invalid.http.sregex)
       .optional().isString().isLength({max: 256}),
      
       //http-fregex
       body('http.fregex', errors.invalid.http.fregex)
       .optional().isString().isLength({max: 256}),
      
       //http-body
       body('http.body', errors.invalid.http.body)
       .optional().custom(value => {
        if (!value) return false;

        try {
          // json
          let body = JSON.stringify(value);
          
          // max: 8192
          if(body.length <= 8192) {
            return true;
          }
          else {
            console.debug(`HTTP body exceeded maximum length (${body.length} > 8192)`);
          }
        }
        catch(ex) {
          console.debug(`Couldn't parse body for http-action (exception = ${ex})`);
          return false;
        }
        return false;
       })
      ],
    // broker
    [
      // broker-subject
      body('broker.subject', errors.invalid.broker.subject)
      .isString().isLength({max: 128}),      
      
      // broker-message
      body('broker.message', errors.invalid.broker.message)
      .custom(value => {
        if (! value) return false;

        try {
          // json
          let message = JSON.stringify(value);
          
          // max:8192
          if(message.length <= 8192) {
            return true;
          }
          else {
            console.debug(`Broker message exceeded maximum length (${message.length} > 8192)`);
          }
        }
        catch(ex) {
          console.debug(`Couldn't parse message for broker-action (exception = ${ex})`);
          return false;
        }
        return false;
      })
    ]/*,
    // jscode
    [
      // code
      body('jscode.snippet', errors.invalid.jscode.snippet).isString().isLength({max: 1024})
    ]*/
  ], errors.invalid.action)
  ], 
  // handler
  (req, res) => {
    const validationErrors = validationResult(req);
    if (!validationErrors.isEmpty()) {

      let errors = [];
      for(let error of validationErrors.array()) {
        errors.push(error.msg);
        if(error.hasOwnProperty('nestedErrors')) {
          for(let nestedError of error.nestedErrors) {
            errors.push(nestedError.msg);
          }
        }
      }
      return res.status(400).json({ status: 'error', errors: errors });
    }

    let jobSpec = {
      time: req.body.time,
      timezone: req.body.timezone || 'UTC',
      name: req.body.name,
      description: req.body.description,
      http: req.body.http,
      broker: req.body.broker,
      jscode: req.body.jscode
    };

    cronManager.createJob(req.service /*tenant*/, jobSpec).then((jobId) => {
      return res.status(201).json({status: 'success', jobId: jobId});
    }).catch(error => {
      console.debug(`Something unexpected happened (${error})`);
      return res.status(500).json({status: 'error', errors: [errors.internal]});
    });

});

// TODO
// PUT /cron/v1/jobs/:id
// 200 Ok
// 204 No Content
// 201 Created
// 404 Not Found
// 500 Internal Server Error

// TODO
// GET /cron/v1/jobs?search=<name>
// GET /cron/v1/jobs?sort=-name, +description
// GET /cron/v1/jobs?page=<page_number>
// GET /cron/v1/jobs?fileds=name, description

// GET /cron/v1/jobs/:id
app.get('/cron/v1/jobs/:id?',[],
 // handler
 (req, res) => {

  let jobId = req.params.id || null;

  // get(jobId)
  if (jobId) {
    cronManager.readJob(req.service /*tenant*/, jobId).then(
      (job) => {
        return res.status(200).json(job);
      }).catch(
        error => {
          if(error instanceof cron.JobNotFound) {
            return res.status(404).json({status: 'error', errors: [errors.notfound]});
          }
          else {
            return res.status(500).json({status: 'error', errors: [errors.internal]});
          }
        }
    );
  }
  // get(all)
  else {
    cronManager.readAllJobs(req.service /*tenant*/).then(
      (jobs) => {
        return res.status(200).json(jobs);
      }).catch(
        error => {
          console.debug(`Something unexpected happened (${error})`);
          return res.status(500).json({status: 'error', errors: [errors.internal]});
        }
    );
  }
});


// DELETE /cron/v1/jobs/:id
app.delete('/cron/v1/jobs/:id',[],
 // handler
 (req, res) => {

  let jobId = req.params.id || null;

  cronManager.deleteJob(req.service /*tenant*/, jobId).then(
    () => {
      return res.status(204).send();
    }).catch(
      error => {
        if(error instanceof cron.JobNotFound) {
          return res.status(404).json({status: 'error', errors: [errors.notfound]});
        }
        else {
          return res.status(500).json({status: 'error', errors: [errors.internal]});
        }
      });
    }
);


module.exports = {
    init: (mgr) => {
      cronManager = mgr;
      app.listen(5000, () => {console.info('[api] Cron service listening on port 5000');});
    }
  };