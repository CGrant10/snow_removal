/* Customer app's worker. Registered from /reserve/, so its scope is
   /reserve/ and it can't collide with the board's. All the logic is in
   the shared core; this only says where things are. */
self.APP_BASE = "../";
self.APP_SHELL = ["app.js"];
importScripts("../sw-core.js");
