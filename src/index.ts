import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const OWM_API_BASE = "https://api.openweathermap.org";
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

// Never hardcode the key. It is supplied via the environment so the source
// stays shareable. See README / claude_desktop_config.json.
const OWM_API_KEY = process.env.OPENWEATHER_API_KEY;

// Create server instance
const server = new McpServer({
  name: "weather",
  version: "1.0.0",
});

type Units = "metric" | "imperial";

function tempUnit(units: Units): string {
  return units === "imperial" ? "°F" : "°C";
}

function speedUnit(units: Units): string {
  return units === "imperial" ? "mph" : "m/s";
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Helper function for making OpenWeather API requests
async function makeOWMRequest<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  if (!OWM_API_KEY) {
    throw new Error(
      "OPENWEATHER_API_KEY is not set. Add it to the server's env configuration.",
    );
  }

  const url = new URL(path, OWM_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("appid", OWM_API_KEY);

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "OpenWeather rejected the API key (401). Check that OPENWEATHER_API_KEY is correct and activated.",
      );
    }
    if (response.status === 429) {
      throw new Error("OpenWeather rate limit exceeded (429). Try again shortly.");
    }
    throw new Error(`OpenWeather request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

// Helper function for making NWS API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

interface GeoResult {
  name: string;
  lat: number;
  lon: number;
  country: string;
  state?: string;
}

interface ResolvedLocation {
  latitude: number;
  longitude: number;
  label: string;
}

// Turn a city name into coordinates, or pass through explicit coordinates.
async function resolveLocation(args: {
  location?: string;
  latitude?: number;
  longitude?: number;
}): Promise<ResolvedLocation> {
  if (args.location) {
    const results = await makeOWMRequest<GeoResult[]>("/geo/1.0/direct", {
      q: args.location,
      limit: "1",
    });

    if (!results.length) {
      throw new Error(
        `Could not find a location matching "${args.location}". Try adding a country code, e.g. "Springfield,US".`,
      );
    }

    const match = results[0];
    const parts = [match.name, match.state, match.country].filter(Boolean);
    return {
      latitude: match.lat,
      longitude: match.lon,
      label: parts.join(", "),
    };
  }

  if (args.latitude !== undefined && args.longitude !== undefined) {
    return {
      latitude: args.latitude,
      longitude: args.longitude,
      label: `${args.latitude}, ${args.longitude}`,
    };
  }

  throw new Error(
    "Provide either a `location` name, or both `latitude` and `longitude`.",
  );
}

const locationShape = {
  location: z
    .string()
    .optional()
    .describe(
      'City name, optionally with country/state code. Examples: "Tokyo", "Paris,FR", "Springfield,US-IL". Preferred over coordinates.',
    ),
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe("Latitude, used only when no location name is given"),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Longitude, used only when no location name is given"),
  units: z
    .enum(["metric", "imperial"])
    .optional()
    .describe("metric = °C and m/s (default), imperial = °F and mph"),
};

// Register weather tools

interface CurrentWeatherResponse {
  weather: Array<{ main?: string; description?: string }>;
  main: {
    temp: number;
    feels_like: number;
    temp_min: number;
    temp_max: number;
    pressure: number;
    humidity: number;
  };
  wind?: { speed?: number; deg?: number; gust?: number };
  clouds?: { all?: number };
  visibility?: number;
  sys?: { country?: string };
  name?: string;
}

server.registerTool(
  "get_current_weather",
  {
    description:
      "Get the current weather conditions for any location worldwide, by city name or coordinates",
    inputSchema: z.object(locationShape),
  },
  async ({ location, latitude, longitude, units }) => {
    const unitSystem: Units = units ?? "metric";

    try {
      const place = await resolveLocation({ location, latitude, longitude });
      const data = await makeOWMRequest<CurrentWeatherResponse>(
        "/data/2.5/weather",
        {
          lat: String(place.latitude),
          lon: String(place.longitude),
          units: unitSystem,
        },
      );

      const condition = data.weather?.[0]?.description ?? "Unknown";
      const lines = [
        `Current weather for ${place.label}:`,
        "",
        `Condition: ${condition}`,
        `Temperature: ${data.main.temp.toFixed(1)}${tempUnit(unitSystem)} (feels like ${data.main.feels_like.toFixed(1)}${tempUnit(unitSystem)})`,
        `Range today: ${data.main.temp_min.toFixed(1)} to ${data.main.temp_max.toFixed(1)}${tempUnit(unitSystem)}`,
        `Humidity: ${data.main.humidity}%`,
        `Pressure: ${data.main.pressure} hPa`,
      ];

      if (data.wind?.speed !== undefined) {
        lines.push(
          `Wind: ${data.wind.speed.toFixed(1)} ${speedUnit(unitSystem)}${
            data.wind.gust !== undefined
              ? ` (gusts ${data.wind.gust.toFixed(1)} ${speedUnit(unitSystem)})`
              : ""
          }`,
        );
      }
      if (data.clouds?.all !== undefined) {
        lines.push(`Cloud cover: ${data.clouds.all}%`);
      }
      if (data.visibility !== undefined) {
        lines.push(`Visibility: ${(data.visibility / 1000).toFixed(1)} km`);
      }

      return textResult(lines.join("\n"));
    } catch (error) {
      return textResult(
        `Failed to retrieve current weather: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
);

interface ForecastEntry {
  dt: number;
  main: { temp: number; humidity: number };
  weather: Array<{ description?: string }>;
  wind?: { speed?: number };
  pop?: number;
}

interface ForecastResponse {
  list: ForecastEntry[];
  city?: { name?: string; country?: string; timezone?: number };
}

// The API returns 40 three-hourly entries. Collapse them into one line per
// local calendar day so the response stays readable.
function summarizeByDay(
  entries: ForecastEntry[],
  timezoneOffsetSeconds: number,
  units: Units,
): string[] {
  const days = new Map<string, ForecastEntry[]>();

  for (const entry of entries) {
    const shifted = new Date((entry.dt + timezoneOffsetSeconds) * 1000);
    const key = shifted.toISOString().slice(0, 10);
    const bucket = days.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      days.set(key, [entry]);
    }
  }

  const summaries: string[] = [];

  for (const [key, dayEntries] of days) {
    const temps = dayEntries.map((e) => e.main.temp);
    const min = Math.min(...temps);
    const max = Math.max(...temps);

    // Most frequently forecast condition wins; ties resolve to the earliest.
    const counts = new Map<string, number>();
    for (const entry of dayEntries) {
      const description = entry.weather?.[0]?.description ?? "unknown";
      counts.set(description, (counts.get(description) ?? 0) + 1);
    }
    let condition = "unknown";
    let best = 0;
    for (const [description, count] of counts) {
      if (count > best) {
        condition = description;
        best = count;
      }
    }

    const windSpeeds = dayEntries
      .map((e) => e.wind?.speed)
      .filter((s): s is number => s !== undefined);
    const maxWind = windSpeeds.length ? Math.max(...windSpeeds) : undefined;

    const pops = dayEntries
      .map((e) => e.pop)
      .filter((p): p is number => p !== undefined);
    const maxPop = pops.length ? Math.max(...pops) : undefined;

    const label = new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

    const details = [
      `${min.toFixed(0)} to ${max.toFixed(0)}${tempUnit(units)}`,
      condition,
    ];
    if (maxWind !== undefined) {
      details.push(`wind up to ${maxWind.toFixed(1)} ${speedUnit(units)}`);
    }
    if (maxPop !== undefined) {
      details.push(`precipitation chance ${Math.round(maxPop * 100)}%`);
    }

    summaries.push(`${label}: ${details.join(", ")}`);
  }

  return summaries;
}

server.registerTool(
  "get_forecast",
  {
    description:
      "Get a 5-day weather forecast for any location worldwide, by city name or coordinates",
    inputSchema: z.object(locationShape),
  },
  async ({ location, latitude, longitude, units }) => {
    const unitSystem: Units = units ?? "metric";

    try {
      const place = await resolveLocation({ location, latitude, longitude });
      const data = await makeOWMRequest<ForecastResponse>(
        "/data/2.5/forecast",
        {
          lat: String(place.latitude),
          lon: String(place.longitude),
          units: unitSystem,
        },
      );

      const entries = data.list ?? [];
      if (!entries.length) {
        return textResult(`No forecast periods available for ${place.label}`);
      }

      const summaries = summarizeByDay(
        entries,
        data.city?.timezone ?? 0,
        unitSystem,
      );

      return textResult(
        `5-day forecast for ${place.label}:\n\n${summaries.join("\n")}`,
      );
    } catch (error) {
      return textResult(
        `Failed to retrieve forecast: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
);

// Alerts stay on the National Weather Service: OpenWeather only exposes them
// through the paid One Call 3.0 plan. US locations only.
server.registerTool(
  "get_alerts",
  {
    description:
      "Get active weather alerts for a US state. Only supports United States locations.",
    inputSchema: z.object({
      state: z
        .string()
        .length(2)
        .describe("Two-letter US state code (e.g. CA, NY)"),
    }),
  },
  async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

    if (!alertsData) {
      return textResult("Failed to retrieve alerts data");
    }

    const features = alertsData.features || [];
    if (!features.length) {
      return textResult(`No active alerts for ${stateCode}`);
    }

    const formattedAlerts = features.map(formatAlert);
    return textResult(
      `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`,
    );
  },
);

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

// Format alert data
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

interface AlertsResponse {
  features: AlertFeature[];
}

async function main() {
  if (!OWM_API_KEY) {
    console.error(
      "WARNING: OPENWEATHER_API_KEY is not set. get_current_weather and get_forecast will fail until it is provided.",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
