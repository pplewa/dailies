var Evernote = require('evernote').Evernote;
var Settings = require('settings');
var Handlebars = require('handlebars');
var moment = require('moment');
var fs = require('fs');
var Q = require('q');
var request = require('request');
var config = new Settings(require('./config'));

function getToken() {
	var client = new Evernote.Client({
		consumerKey: config.evernote.key,
		consumerSecret: config.evernote.secret,
		sandbox: config.evernote.sandbox
	});
	client.getRequestToken('about:blank', function(error, oauthToken, oauthTokenSecret, results) {
		// store tokens in the session
		// and then redirect to client.getAuthorizeUrl(oauthToken)
	});
}

function makeNote(noteStore, noteTitle, noteBody, parentNotebook, callback) {
	var nBody = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";
	nBody += "<!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\">";
	nBody += "<en-note>" + noteBody + "</en-note>";
 
	// Create note object
	var date = new Date();
	var now = moment([date.getFullYear(), date.getMonth(), date.getDate()]);
	var ourNote = new Evernote.Note({
		title: noteTitle,
		content: nBody,
		created: now.date(now.date()-1).valueOf()
	});
 
	// parentNotebook is optional; if omitted, default notebook is used
	if (parentNotebook && parentNotebook.guid) {
		ourNote.notebookGuid = parentNotebook.guid;
	}
 
	// Attempt to create note in Evernote account
	noteStore.createNote(ourNote, function(err, note) {
		if (err) {
			// Something was wrong with the note data
			// See EDAMErrorCode enumeration for error code explanation
			// http://dev.evernote.com/documentation/reference/Errors.html#Enum_EDAMErrorCode
			console.log(err);
		} else {
			callback(note);
		}
	});
}


var template = fs.readFileSync('template.hbs', { encoding: 'utf-8' });
var getTemplate = Handlebars.compile(template);

var client = new Evernote.Client({
	token: config.evernote.accessToken,
	sandbox: config.evernote.sandbox
});
var noteStore = client.getNoteStore();

function getMemories(noteStore) {
	var deferred = Q.defer();
	var filter = new Evernote.NoteFilter({
		words: 'notebook:journal intitle:' + moment().date(moment().date()-1).format('DD/MM/'),
		order: Evernote.NoteSortOrder.CREATED,
		ascending: false
	});
	var noteSpec = new Evernote.NotesMetadataResultSpec({
		includeTitle: true
	})
	noteStore.findNotesMetadata(filter, 0, 10, noteSpec, function(error, data){
		if (error) {
			deferred.reject(new Error(error));
		} else {
			deferred.resolve(data.notes);
		}
	});
	return deferred.promise;
}

function getMappiness() {
	var deferred = Q.defer();
	request({ url: config.mappiness.url, json: true }, function (error, response, data) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			var a=0, h=0, r=0, logs = 0, date = new Date();
			var now = moment([date.getFullYear(), date.getMonth(), date.getDate()]);
			for (var i = 0; i < 10; i++) {
				var logDate = new Date(data[i].start_time_epoch*1000);
				var diff = now.diff(moment([logDate.getFullYear(), logDate.getMonth(), logDate.getDate()]), 'days');
				if (diff === 1) {
					logs++;
					a += data[i].awake;
					h += data[i].happy;
					r += data[i].relaxed;
				}
			}
			function getVal(val) {
				return +(val/logs).toFixed(3);
			}
			function getFace(face) {
				var faces = ['😫', '😟', '😐', '😌', '😀'];
				return faces[Math.round((face/logs)*5)-1];
			}

			deferred.resolve([
				{ name: 'Logs', 'value': logs },
				{ name: 'Happy', 'value': getVal(h) + ' ' + getFace(h) },
				{ name: 'Relax', 'value': getVal(r) + ' ' + getFace(r) },
				{ name: 'Awake', 'value': getVal(a) + ' ' + getFace(a) },
				{ name: 'Productivity', 'value': '0' }
			]);
  		};
	});
	return deferred.promise;
}


Q.all([getMemories(noteStore), getMappiness()]).spread(function(notes, mappiness){
	var memories = [];
	notes.forEach(function(note){
		memories.push({
			link: 'evernote:///view/' + config.evernote.userId + '/' + config.evernote.shardId + '/' + note.guid + '/' + note.guid + '/',
			title: note.title
		});
	});

	var noteTitle = moment().date(moment().date()-1).format('DD/MM/YYYY ddd');
	var noteBody = getTemplate({ 
		memories: memories,
		mappiness: mappiness
	});
	makeNote(noteStore, noteTitle, noteBody, null, function(err, note){
		console.log('ok');
	});
});
