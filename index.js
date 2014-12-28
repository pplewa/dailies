var Evernote = require('evernote').Evernote;
var MovesApi = require('moves-api').MovesApi;
var Settings = require('settings');
var Handlebars = require('handlebars');
var moment = require('moment');
var fs = require('fs');
var Q = require('q');
var html2enml = require('html2enml2').convert;
var polyUtil = require('polyline-encoded');
var request = require('request');
var config = new Settings(require('./config'));

// Handlebards helpers
Handlebars.registerHelper("mins", function(value) {
	return Math.round(value/60);
});

Handlebars.registerHelper("config", function(val1, val2) {
	return config[val1][val2];
});

//
var template = fs.readFileSync('template.hbs', { encoding: 'utf-8' });
var getTemplate = Handlebars.compile(template);

//
var client = new Evernote.Client({
	token: config.evernote.accessToken,
	sandbox: config.evernote.sandbox
});
var noteStore = client.getNoteStore();

// 
var moves = new MovesApi(config.moves);

function makeNote(noteTitle, noteBody, parentNotebook) {
	var deferred = Q.defer();

	html2enml('<body>' + noteBody + '</body>', '', function(enml, res){
		var date = new Date();
		var yesterday = moment([date.getFullYear(), date.getMonth(), date.getDate()]).subtract(1, 'day');
		var ourNote = new Evernote.Note({
			title: noteTitle,
			tagNames: ['Journal', yesterday.format('YYYY'), yesterday.format('MMMM'), yesterday.format('dddd')],
			content: enml,
			created: yesterday.valueOf(),
			resources: res
		});
	 
		// parentNotebook is optional; if omitted, default notebook is used
		if (parentNotebook && parentNotebook.guid) {
			ourNote.notebookGuid = parentNotebook.guid;
		}
	 
		// Attempt to create note in Evernote account
		noteStore.createNote(ourNote, function(error, note) {
			if (error) {
				console.log(arguments);
				deferred.reject(new Error(error));
				// Something was wrong with the note data
				// See EDAMErrorCode enumeration for error code explanation
				// http://dev.evernote.com/documentation/reference/Errors.html#Enum_EDAMErrorCode
			} else {
				deferred.resolve(note);
			}
		});
	});
	return deferred.promise;	
}

function getMemories() {
	var deferred = Q.defer();
	var filter = new Evernote.NoteFilter({
		words: 'notebook:journal intitle:' + moment().subtract(1, 'day').format('DD/MM/'),
		order: Evernote.NoteSortOrder.CREATED,
		ascending: false
	});
	var foodFilter = new Evernote.NoteFilter({
		words: 'notebook:food created:day-1',
		// words: 'notebook:food created:day-1 -created:day',
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
			var memories = [];
			data.notes.forEach(function(note){
				memories.push({
					link: 'evernote:///view/' + config.evernote.userId + '/' + config.evernote.shardId + '/' + note.guid + '/' + note.guid + '/',
					title: note.title
				});
			});
			noteStore.findNotesMetadata(foodFilter, 0, 10, noteSpec, function(error, data){
				data.notes.forEach(function(note){
					memories.push({
						link: 'evernote:///view/' + config.evernote.userId + '/' + config.evernote.shardId + '/' + note.guid + '/' + note.guid + '/',
						title: note.title
					});
				});
				deferred.resolve(memories);
			});
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
				{ name: 'Productivity', 'value': '0 😫😟😐😌😀' }
			]);
		};
	});
	return deferred.promise;
}


function getStoryline() {
	var deferred = Q.defer();
	moves.getStoryline({ trackPoints: true, date: moment().subtract(1, 'day') }, function(error, storylines) {
		if (error) {
			deferred.reject(new Error(error));
		} else {
			var storyline = {
				summary: storylines[0].summary,
				paths: [],
				segments: []
			};

			var paths = [];
			storylines[0].segments.forEach(function(seg, i){
				paths[i] = {
					walking: [],
					traveling: []
				};
				seg.activities.forEach(function(activity){
					if (activity.activity === 'walking') {
						activity.trackPoints.forEach(function(point){
							paths[i].walking.push([point.lat, point.lon]);
						});
					} else {
						 activity.trackPoints.forEach(function(point){
							paths[i].traveling.push([point.lat, point.lon]);
						});
					}
				});
			});
			paths.forEach(function(path){
				if (path.walking.length){
					storyline.paths.push('path=color:0xff0000ff|enc:' + polyUtil.encode(path.walking));
				} else if (path.traveling.length){
					storyline.paths.push('path=color:0x666666ff|enc:' + polyUtil.encode(path.traveling));
				}
			});

			storylines[0].segments.forEach(function(segment, i){
				if (segment.place) {
					var temp = {
						start: moment(segment.startTime, 'YYYYMMDDTHms').format('HH:mm'),
						end: moment(segment.endTime, 'YYYYMMDDTHms').format('HH:mm')
					};
					temp.activity = segment.activities[0].activity;
					if (segment.activities.length === 1) {
						temp.duration = segment.activities[0].duration;
						temp.distance = segment.activities[0].distance;
						temp.steps = segment.activities[0].steps;
						temp.calories = segment.activities[0].calories;
					} else if (segment.activities.length > 1) {
						temp.duration = segment.activities.reduce(function(a, b){ return (a.duration || 0) + (b.duration || 0); });
						temp.distance = segment.activities.reduce(function(a, b){ return (a.distance || 0) + (b.distance || 0); });
						temp.steps = segment.activities.reduce(function(a, b){ return (a.steps || 0) + (b.steps || 0); });
						temp.calories = segment.activities.reduce(function(a, b){ return (a.calories || 0) + (b.calories || 0); });
					}
					if (i === 0) temp.start = '00:00';
					if (i === storylines[0].segments.length - 1) temp.end = '00:00';
					temp.place = {
						name: segment.place.name,
						lon: segment.place.location.lon,
						lat: segment.place.location.lat,
						foursquareId: segment.place.foursquareId,
						type: segment.place.type
					};
					storyline.segments.push(temp);
				} else {
					var path = '', start, finish;
					segment.activities.forEach(function(activity){
						var temp = {
							start: moment(activity.startTime, 'YYYYMMDDTHms').format('HH:mm'),
							end: moment(activity.endTime, 'YYYYMMDDTHms').format('HH:mm'),
							activity: activity.activity,
							duration: activity.duration,
							distance: activity.distance,
							calories: activity.calories,
							steps: activity.steps
						};
						if (activity.trackPoints) {
							start = {
								lat: activity.trackPoints[0].lat,
								lon: activity.trackPoints[0].lon
							}
							finish = {
								lat: activity.trackPoints[activity.trackPoints.length-1].lat,
								lon: activity.trackPoints[activity.trackPoints.length-1].lon
							}
							var path = polyUtil.encode(activity.trackPoints.map(function(point){
								return [point.lat, point.lon];								
							}));
						}
						temp.route = {
							path: 'enc:' + path,
							start: start,
							finish: finish
						};
						storyline.segments.push(temp);
					});
				}

				deferred.resolve(storyline);
			});
		}
	});
	return deferred.promise;
}

Q.all([getMemories(), getMappiness(), getStoryline()]).spread(function(memories, mappiness, storyline){
	var noteTitle = moment().subtract(1, 'day').format('DD/MM/YYYY ddd');
	var noteBody = getTemplate({ 
		memories: memories,
		mappiness: mappiness,
		storyline: storyline
	});

	makeNote(noteTitle, noteBody).then(function(note){
		console.log('ok');
	});
}).fail(function(){
	console.log(arguments);	
});