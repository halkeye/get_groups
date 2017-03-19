var fs = require('fs');
var google = require('googleapis');
var template = require('lodash').template;
var sortBy = require('lodash').sortBy;
var mkdir = require('mkdir-promise');
var program = require('commander');
var promisify = require('es6-promisify');

program
  .option('-e, --email <email>', 'Email address to impersonate')
  .option('-i, --ignore <csv>', 'Comma Seperated list of group ids to ignore')
  .parse(process.argv)

function sleep(ms = 0) {
  return new Promise(r => setTimeout(r, ms));
}

class Cache {
  constructor() {
    this._cache = {};
  }

  get(key) {
    return Promise.resolve(this._cache[key]);
  }

  set(key, val) {
    this._cache[key] = val;
  }
};
var cache = new Cache();

var email = program.email || process.env.EMAIL || process.argv[2];
var filteredOutGroupIds = (program.ignore || '').split(',');

var admin = google.admin('directory_v1');
var plus = google.plus('v1');
plus.people.getAsync = promisify(plus.people.get, plus.people);
admin.members.listAsync = promisify(admin.members.list, admin.members);
admin.groups.listAsync = promisify(admin.groups.list, admin.groups);
admin.users.getAsync = promisify(admin.users.get, admin.users);

// generate a url that asks permissions for Google+ and Google Calendar scopes
var scopes = [
  'email',
  'profile',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
	'https://www.googleapis.com/auth/admin.directory.user.readonly',
	'https://www.googleapis.com/auth/admin.directory.user.alias.readonly'
]//.map(scope => scope.replace('.readonly', ''));
console.log(scopes.join(','));

function getDomain() {
  return plus.people.getAsync({ userId: 'me' })
    .then(response => response.domain);
}

function getGroups(domain) {
  return admin.groups.listAsync({ domain: domain })
    .then(response => response.groups)
    .then(groups => groups.filter(group => !/\*HIDDEN\*/.test(group.description)))
    .then(groups => groups.filter(group => filteredOutGroupIds.indexOf(group.id) === -1 ));
}

/*
function getGroupAliases(groupKey) {
  var admin = google.admin('directory_v1');
  return new Promise(function (resolve, reject) {
    admin.groups.aliases.list({ groupKey: groupKey }, function(err, response) {
      if (err) { reject(err); }
      else { resolve(response); }
    });
  });
}
*/

function getGroupMembers(group) {
  var key = `groupMembers:${group.id}:${group.etag}`;
  return cache.get(key).then(members => {
    if (!members) {
      return admin.members.listAsync({ groupKey: group.id })
        .then(response => {
          cache.set(key, JSON.stringify(response.members || []));
          return response.members || [];
        }).catch(err => {
          if (Array.isArray(err.errors)) {
            if (err.errors[0].reason === 'quotaExceeded') {
              console.log('getGroup - Quota expired for', group.id, 'retrying in 60');
              return sleep(60).then(() => getGroupMembers(group));
            }
            if (err.errors[0].reason === 'backendError') {
              console.log('getGroup - Backend error for', group.id, 'retrying in 60');
              return sleep(60).then(() => getGroupMembers(group));
            }
          }
          console.error("error getting group members for", group.id, err);
          return [];
          // throw err;
        });
    } else {
      return JSON.parse(members.value);
    }
  });
}

function getUser(user) {
  var key = `user:${user.id}:${user.etag}`;
  return cache.get(key).then(data => {
    if (!data) {
      return admin.users.getAsync({ userKey: user.id })
        .then(response => {
          cache.set(key, JSON.stringify(response || {}));
          return response || {};
        }).catch(err => {
          if (Array.isArray(err.errors) && err.errors[0].reason === 'quotaExceeded') {
            console.log('getUser - Quota expired for', user.id, 'retrying in 60');
            return sleep(60).then(() => getUser(user));
          }
          throw err;
        });
    } else {
      return JSON.parse(data.value);
    }
  });
}

function getCredentials() {
  return new Promise(function(resolve, reject) {
    var file = process.env.GOOGLE_ACCOUNT_FILE || 'sauce-get-groups-f91bad07e092.json';
    fs.readFile(file, function(err, contents) {
      if (err) { return reject(err); }
      var key = JSON.parse(contents);
      var jwtClient = new google.auth.JWT(
        key.client_email,
        null,
        key.private_key,
        scopes,
        email
      );
      jwtClient.authorize(function (err) {
        if (err) { return reject(err); }
        google.options({ auth: jwtClient });
        resolve();
      });
    });
  });
}


function makeGroupsJson() {
  return getCredentials().then(function() {
    return getDomain().then(function(domain) {
      return getGroups(domain).then(function (groups) {
        var promises = groups.map(function(group) {
          return getGroupMembers(group).then(function(members) {
            group.members = [];
            return Promise.all(members.map(function(member) {
              return getUser(member).catch(function() {
                /* if not found, i don't care */
                return member
              }).then(function(member) {
                group.members.push(member);
              });
            })).then(function() {
              sortBy(group.members, ['email']);
              return group;
            });
          });
        });
        return Promise.all(promises);
      });
    });
  }).then(function(groups) {
    fs.writeFileSync('groups.json', JSON.stringify(groups, null, '\t'));
    return groups;
  }).catch(function(err) {
    console.error('err', err);
  });
}

function makeHtmlFile(groups) {
  return new Promise(function(resolve, reject) {
    fs.readFile('./template.html', function(err, contents) {
      if (err) { return reject(err); }

      var compiled = template(contents);
      return resolve(compiled({groups: groups}));
    });
  }).then(function(html) {
    return mkdir('public').then(function() {
      return new Promise(function(resolve, reject) {
        fs.writeFile('public/index.html', html, function(err) {
          if (err) { return reject(err); }
          resolve();
        });
      });
    });
  });
}

if (require.main === module) {
  makeGroupsJson().then(makeHtmlFile).catch(err => console.err(err));
}
module.exports = {
  makeGroupsJson: makeGroupsJson,
  makeHtmlFile: makeHtmlFile
}
