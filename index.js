var fs = require('fs');
var google = require('googleapis');
var template = require('lodash').template;
var sortBy = require('lodash').sortBy;
var mkdir = require('mkdir-promise');
var program = require('commander');

program
  .option('-c, --cache-dir <dir>', 'Directory to write cache to')
  .option('-e, --email <email>', 'Email address to impersonate')
  .option('-i, --ignore <csv>', 'Comma Seperated list of group ids to ignore')
  .parse(process.argv)

function sleep(ms = 0) {
  return new Promise(r => setTimeout(r, ms));
}

var Cache = require('async-disk-cache');
var cache = new Cache('get-groups', {
  location: program.cacheDir || './cache'
});

var email = program.email || process.env.EMAIL || process.argv[2];
var filteredOutGroupIds = (program.ignore || '').split(',');

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
  var plus = google.plus('v1');
  return new Promise(function(resolve, reject) {
    plus.people.get({ userId: 'me' }, function(err, peopleResponse) {
      if (err) { return reject(err); }
      resolve(peopleResponse.domain);
    });
  });
}

function getGroups(domain) {
  var admin = google.admin('directory_v1');
  return new Promise(function (resolve, reject) {
    admin.groups.list({ domain: domain }, function(err, response) {
      if (err) { reject(err); }
      else { resolve(response.groups); }
    });
  })
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
  var admin = google.admin('directory_v1');
  var key = `groupMembers:${group.id}:${group.etag}`;
  return new Promise(function (resolve, reject) {
    cache.get(key).then(members => {
      if (!members.isCached) {
        admin.members.list({ groupKey: group.id }, function(err, response) {
          //if (err) { reject(err); }
          if (err) {
            if (Array.isArray(err.errors) && err.errors[0].reason === 'quotaExceeded') {
              console.log('Quota expired for', group.id, 'retrying in 60');
              return sleep(60).then(() => getGroupMembers(group));
            }
            console.error("error getting group members for", group.id, err);
            reject(err);
          }
          else {
            cache.set(key, JSON.stringify(response.members || []));
            resolve(response.members || []);
          }
        });
      } else {
        resolve(JSON.parse(members.value));
      }
    }).catch(err => reject(err));
  });
}

function getUser(user) {
  var admin = google.admin('directory_v1');
  var key = `user:${user.id}:${user.etag}`;
  return new Promise(function (resolve, reject) {
    cache.get(key).then(data => {
      if (!data.isCached) {
        admin.users.get({ userKey: user.id }, function(err, response) {
          if (err) { reject(err); }
          else {
            cache.set(key, JSON.stringify(response || {}));
            resolve(response || {});
          }
        });
      } else {
        resolve(JSON.parse(data.value));
      }
    });
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
  makeGroupsJson().then(makeHtmlFile);
}
module.exports = {
  makeGroupsJson: makeGroupsJson,
  makeHtmlFile: makeHtmlFile
}
