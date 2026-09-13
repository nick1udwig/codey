"use strict";
var Pam = require("./pam");
var Wire = require("./watch-protocol");
var KEY = "pebble-agent.notes.v1";
var LIST_SIZE = 8, CHUNKS_PER_PAGE = 4;
function Store(storage) { this.storage = storage; }
Store.prototype.load = function() {
  var raw = this.storage.getItem(KEY);
  var db = raw ? JSON.parse(raw) : { sequence:0, entries:[], operations:{} };
  if (!db || !Array.isArray(db.entries) || !db.operations || typeof db.sequence !== "number") throw new Error("Phone note storage is unreadable.");
  return db;
};
Store.prototype.count = function() { return this.load().entries.length; };
Store.prototype.mutate = function(attrs, operation) {
  if (attrs.command !== "add" && attrs.command !== "edit") throw new Error("Unsupported note command.");
  var db = this.load(), edit = attrs.command === "edit", text = String(attrs.value || "");
  if (operation && db.operations[operation]) return db.operations[operation];
  if (!text.trim()) throw new Error("Note text is empty.");
  if (text.length > 65536) throw new Error("Note exceeds the 64K character limit.");
  var matches = db.entries.filter(function(n) { return attrs.id ? n.id === attrs.id : edit && n.text === attrs.match; });
  if (edit && matches.length !== 1) throw new Error(matches.length ? "Several notes match. Open one and choose Edit note." : "Note not found.");
  if (!edit && matches.length) {
    if (matches[0].text !== text) throw new Error("Note ID already exists with different contents.");
    return matches[0].id;
  }
  var id = attrs.id;
  if (!edit && !id) {
    do { id="phone-"+(++db.sequence).toString(36); } while(db.entries.some(function(n){return n.id===id;}));
  }
  var note = edit ? matches[0] : { id:id };
  if (!note.id || Wire.truncateUtf8(note.id,31)!==note.id || /[\x00-\x1f]/.test(note.id)) throw new Error("Invalid note ID.");
  note.text = text;
  if (!edit) db.entries.push(note);
  if (operation) db.operations[operation] = note.id;
  // Commit the record and replay key together; no acknowledged in-memory-only writes.
  this.storage.setItem(KEY, JSON.stringify(db));
  return note.id;
};
function line(kind, attrs) { return "  " + kind + " " + Pam.formatAttributes(attrs) + "\n"; }
Store.prototype.render = function(id, page) {
  var entries = this.load().entries, note = id && entries.filter(function(n){return n.id===id;})[0];
  if (id && !note) throw new Error("Note not found on phone.");
  page = Math.max(0, Math.floor(Number(page) || 0));
  var source = "pam version=1\nscreen " + Pam.formatAttributes({id:note?"note-detail":"notes",layout:"list",title:note?"Note":"Notes",status:true}) + "\n";
  var pages;
  if (note) {
    var chunks = Wire.splitUtf8(note.text, 179);
    pages = Math.max(1, Math.ceil(chunks.length/CHUNKS_PER_PAGE)); page=Math.min(page,pages-1);
    source += line("text",{id:"note-page",value:"Page "+(page+1)+" of "+pages});
    chunks.slice(page*CHUNKS_PER_PAGE,(page+1)*CHUNKS_PER_PAGE).forEach(function(chunk,i){source+=line("text",{id:"body-"+i,value:chunk});});
    source += line("item",{id:note.id,title:"Edit note",subtitle:"Replace entire note by dictation",action:"local.note.edit"});
  } else {
    pages=Math.max(1,Math.ceil(entries.length/LIST_SIZE));page=Math.min(page,pages-1);
    entries.slice(page*LIST_SIZE,(page+1)*LIST_SIZE).forEach(function(n){source+=line("item",{id:n.id,title:Wire.truncateUtf8(n.text.replace(/\s+/g," "),71),action:"local.note.open"});});
    if (!entries.length) source += line("text",{id:"note-empty",value:"No notes yet. Say: make a note ..."});
  }
  var action=note?"local.note.page":"local.note.list";
  if(page>0)source+=line("item",{id:"previous",title:"Previous page",action:action,value:String(page-1),note:note?note.id:""});
  if(page+1<pages)source+=line("item",{id:"next",title:"Next page",action:action,value:String(page+1),note:note?note.id:""});
  if(note)source+=line("item",{id:"notes-back",title:"Back to notes",action:"local.notes"});
  return source+"done\n";
};
module.exports={Store:Store,KEY:KEY};
