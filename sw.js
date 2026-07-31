/* Legacy worker. Nothing registers this any more, but every phone that
   installed the app before the reserve/ + board/ split still has a
   registration pointing here, scoped to the whole site. Deleting the
   file would leave those installs stuck on whatever they last cached,
   because a 404 on the script makes the update check fail and keeps the
   old worker alive. So it stays, serving the redirect page, until those
   installs have replaced themselves. */
self.APP_BASE = "./";
self.APP_SHELL = [];
importScripts("./sw-core.js");
