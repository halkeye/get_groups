var google = require('googleapis');
var OAuth2 = google.auth.OAuth2;

var oauth2Client = new OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);

// generate a url that asks permissions for Google+ and Google Calendar scopes
var scopes = [
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
	'https://www.googleapis.com/auth/admin.directory.user.readonly',
	'https://www.googleapis.com/auth/admin.directory.user.alias.readonly',
];

var tokens = require('./.credentials.json');
if (!tokens) {
  // which at the moment can't happen because of the require erroring
  var url = oauth2Client.generateAuthUrl({
    // 'online' (default) or 'offline' (gets refresh_token)
    access_type: 'offline',

    // If you only need one scope you can pass it as string
    scope: scopes
  });
  console.log(url);

  var code = ''; // get code
  oauth2Client.getToken(code, function (err, tokens) {
    // Now tokens contains an access_token and an optional refresh_token. Save them.
    if (err) { throw err; }
    oauth2Client.setCredentials(tokens);
    console.log(tokens);
  });
}
oauth2Client.setCredentials(tokens);
// set auth as a global default
google.options({ auth: oauth2Client });

var admin = google.admin('directory_v1');
admin.groups.list({ userKey: 'gavin@saucelabs.com' }, {}, function(err, request) {
  if (err) throw err;
  console.log(request.body);
});
