var fs = require('fs');
var google = require('googleapis');
var OAuth2 = google.auth.OAuth2;
var inquirer = require('inquirer');
var template = require('lodash').template;
var sortBy = require('lodash').sortBy;
var mkdir = require("mkdir-promise");

var oauth2Client = new OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);

// generate a url that asks permissions for Google+ and Google Calendar scopes
var scopes = [
  'email',
  'profile',
  // 'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
	'https://www.googleapis.com/auth/admin.directory.user.readonly',
	'https://www.googleapis.com/auth/admin.directory.user.alias.readonly'
];

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
  });
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

function getGroupMembers(groupKey) {
  var admin = google.admin('directory_v1');
  return new Promise(function (resolve, reject) {
    admin.members.list({ groupKey: groupKey }, function(err, response) {
      if (err) { reject(err); }
      else { resolve(response.members); }
    });
  });
}

function getUser(userKey) {
  var admin = google.admin('directory_v1');
  return new Promise(function (resolve, reject) {
    admin.users.get({ userKey: userKey }, function(err, response) {
      if (err) { reject(err); }
      else { resolve(response); }
    });
  });
}

function getCredentials() {
  return new Promise(function(resolve, reject) {
    if (!fs.existsSync('./.credentials.json')) {
      // which at the moment can't happen because of the require erroring
      var url = oauth2Client.generateAuthUrl({
        // 'online' (default) or 'offline' (gets refresh_token)
        access_type: 'offline',

        // If you only need one scope you can pass it as string
        scope: scopes
      });
      console.log('Authorize with');
      console.log(url);
      inquirer.prompt([{ type: 'input', name: 'code', message: 'Enter code from browser'}]).then(function(answers) {
        oauth2Client.getToken(answers.code, function (err, tokens) {
          // Now tokens contains an access_token and an optional refresh_token. Save them.
          if (err) { return reject(err); }
          fs.writeFileSync('.credentials.json', JSON.stringify(tokens));
          oauth2Client.setCredentials(tokens);
          resolve(tokens);
        });
      });
    } else {
      var tokens = require('./.credentials.json');
      if(tokens.expiry_date <= new Date().getTime()) {
        oauth2Client.setCredentials(tokens);
        oauth2Client.refreshAccessToken(function(err, tokens) {
          if (err) { return reject(err); }
          fs.writeFileSync('.credentials.json', JSON.stringify(tokens));
          resolve(tokens);
        });
      } else {
        resolve(tokens);
      }
    }
  });
}


function makeGroupsJson() {
  return getCredentials().then(function(tokens) {
    oauth2Client.setCredentials(tokens);
    // set auth as a global default
    google.options({ auth: oauth2Client });
  }).then(function() {

    return getDomain().then(function(domain) {
      return getGroups(domain).then(function (groups) {
        var promises = groups.map(function(group) {
          return getGroupMembers(group.id).then(function(members) {
            group.members = [];
            return Promise.all(members.map(function(member) {
              return getUser(member.id).catch(function() {
                /* if not found, i don't care */
                return member
              }).then(function(member) {
                group.members.push(member);
              });
            })).then(function() {
              sortBy(group.members, ['id']);
              return group;
            });
          });
        });
        return Promise.all(promises);
      });
    });
  }).then(function(groups) {
    console.log(JSON.stringify(groups, null, '\t'));
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
