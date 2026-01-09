/*
 * Signal K plugin container for a standalone webapp.
 * UI lives in /public and connects to Signal K Streaming API from the browser.
 */
module.exports = function (app) {
  const plugin = {};
  plugin.id = "ais-radar-standalone";
  plugin.name = "AIS Radar (Standalone)";
  plugin.description = "Standalone AIS radar webapp (Canvas) driven by Signal K Streaming API.";

  plugin.schema = function () {
    return {
      type: "object",
      properties: {
        defaultRangeNm: {
          type: "number",
          title: "Default range (NM)",
          default: 2.0,
          minimum: 0.1,
          maximum: 48
        },
        showVectorsDefault: {
          type: "boolean",
          title: "Show COG/SOG vectors by default",
          default: true
        },
        subscribe: {
          type: "string",
          title: "Streaming subscribe mode",
          default: "all",
          enum: ["all", "self"],
          description: "Use 'all' for AIS targets, 'self' for own vessel only."
        }
      }
    };
  };

  let settings = {};

  plugin.start = function (options) {
    settings = options || {};
    app.debug("AIS Radar Standalone plugin started with options: " + JSON.stringify(settings));
  };

  plugin.stop = function () {
    app.debug("AIS Radar Standalone plugin stopped");
  };

  // Same-origin endpoint the webapp can call for defaults
  plugin.registerWithRouter = function (router) {
    router.get("/config", (req, res) => {
      res.json({
        defaultRangeNm: settings.defaultRangeNm ?? 2.0,
        showVectorsDefault: settings.showVectorsDefault ?? true,
        subscribe: settings.subscribe ?? "all"
      });
    });
  };

  return plugin;
};
