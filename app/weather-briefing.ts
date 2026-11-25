export type LocalWeather = {
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  weatherCode: number;
  windSpeed: number;
  isDay: boolean;
  timezone: string;
  locationName: string;
  observedAt: string;
};

export type WeatherForecastDay = {
  date: string;
  weatherCode: number;
  temperatureMax: number;
  temperatureMin: number;
  precipitationProbability: number;
  windSpeed: number;
};

export type ClientWeatherAlert = {
  id: string;
  category: string;
  level: string;
  source: string;
  headline: string;
  description: string;
  areaName: string;
  effectiveTime?: string | null;
  expires?: string | null;
};

export type ClientWeatherConditions = {
  available: boolean;
  message?: string;
  uvIndex?: number | null;
  uvCategory?: string;
  airQualityIndex?: number | null;
  airQualityCategory?: string;
  dominantPollutant?: string;
  airQualityDescription?: string;
};

export type ClientMinuteForecastInterval = {
  minute: number;
  startTime?: string | null;
  dbz: number;
  shortPhrase?: string;
  precipitationType?: string;
  colorHex?: string;
};

export type ClientMinuteForecast = {
  available: boolean;
  message?: string;
  summary?: string;
  briefPhrase60?: string;
  longPhrase?: string;
  hasPrecipitation: boolean;
  isRainingNow: boolean;
  startsInMinutes?: number | null;
  endsInMinutes?: number | null;
  durationMinutes?: number | null;
  maxDbz?: number;
  precipitationType?: string;
  alertState?: "none" | "starting-soon" | "starting-later" | "ongoing-ending" | "ongoing" | string;
  intervals?: ClientMinuteForecastInterval[];
  checkedAtUtc?: string;
};

function precipitationNoun(precipitationType?: string): string {
  switch ((precipitationType ?? "").toLowerCase()) {
    case "snow":
      return "Snow";
    case "ice":
      return "Ice";
    case "mix":
      return "Wintry mix";
    default:
      return "Rain";
  }
}

export function formatMinuteRainHeadline(minuteForecast: ClientMinuteForecast | null | undefined): string {
  if (!minuteForecast?.available || !minuteForecast.hasPrecipitation) return "";
  const noun = precipitationNoun(minuteForecast.precipitationType);
  if ((minuteForecast.alertState === "starting-soon" || minuteForecast.alertState === "starting-later") && minuteForecast.startsInMinutes != null) {
    return `${noun} in ${minuteForecast.startsInMinutes} min`;
  }
  if (minuteForecast.alertState === "ongoing-ending" && minuteForecast.endsInMinutes != null) {
    return `${noun} ending in ${minuteForecast.endsInMinutes} min`;
  }
  if (minuteForecast.alertState === "ongoing") {
    return `${noun} continuing`;
  }
  return (minuteForecast.briefPhrase60 || minuteForecast.summary || "").trim();
}

export function describeWeather(code: number) {
  if (code === 0) return "Clear";
  if (code === 1 || code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95 && code <= 99) return "Thunderstorms";
  return "Local weather";
}

export function weatherBriefing(
  weather: LocalWeather | null,
  forecast: WeatherForecastDay[],
  alerts: ClientWeatherAlert[] = [],
  conditions?: ClientWeatherConditions | null,
  minuteForecast?: ClientMinuteForecast | null,
) {
  if (!weather) return "";
  const place = weather.locationName ? ` for ${weather.locationName}` : "";
  const current = `Here is your weather${place}. Currently, ${describeWeather(weather.weatherCode).toLowerCase()}, ${Math.round(weather.temperature)} degrees Celsius, feeling like ${Math.round(weather.apparentTemperature)} degrees. Wind is ${Math.round(weather.windSpeed)} kilometres per hour.`;
  // Open-Meteo's local observation date matches the forecast location, even
  // when the device is in a different timezone. Never read tomorrow as today.
  const today = forecast.find((day) => day.date === weather.observedAt.slice(0, 10));
  let briefing = today
    ? `${current} Today, expect ${describeWeather(today.weatherCode).toLowerCase()}, with a high of ${Math.round(today.temperatureMax)} and a low of ${Math.round(today.temperatureMin)} degrees Celsius. The chance of rain is ${Math.round(today.precipitationProbability)} percent.`
    : current;

  if (alerts && alerts.length > 0) {
    const warning =
      alerts.length === 1
        ? ` Attention: ${alerts[0].headline}.`
        : ` Attention: ${alerts.length} severe weather alerts in effect, including ${alerts[0].headline}.`;
    briefing += warning;
  }

  if (minuteForecast?.available && minuteForecast.hasPrecipitation) {
    const noun = precipitationNoun(minuteForecast.precipitationType);
    const rawPhrase = (minuteForecast.briefPhrase60 || minuteForecast.summary || "").trim().replace(/[.!?\s]+$/, "");
    if (minuteForecast.alertState === "starting-soon") {
      const phrase = rawPhrase || (minuteForecast.startsInMinutes != null
        ? `${noun} starting in ${minuteForecast.startsInMinutes} minutes`
        : `${noun} starting soon`);
      briefing += ` Rain alert: ${phrase}.`;
    } else if (minuteForecast.alertState === "ongoing-ending") {
      if (minuteForecast.endsInMinutes != null) {
        briefing += ` ${noun} is expected to ease in about ${minuteForecast.endsInMinutes} minutes.`;
      } else if (rawPhrase) {
        briefing += ` ${rawPhrase}.`;
      }
    } else if (minuteForecast.alertState === "ongoing" && rawPhrase) {
      briefing += ` ${rawPhrase}.`;
    }
  }

  if (conditions?.uvIndex !== undefined && conditions?.uvIndex !== null && conditions.uvIndex >= 6) {
    briefing += ` The UV index is ${conditions.uvIndex}, ${conditions.uvCategory || "High"}. Sun protection is recommended.`;
  }

  if (conditions?.airQualityCategory && /unhealthy|poor|hazardous/i.test(conditions.airQualityCategory)) {
    briefing += ` Air quality is ${conditions.airQualityCategory.toLowerCase()}.`;
  }

  return briefing;
}

function formatCalendarDay(date: Date, timeZone?: string): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date);
      const year = parts.find((part) => part.type === "year")?.value;
      const month = parts.find((part) => part.type === "month")?.value;
      const day = parts.find((part) => part.type === "day")?.value;
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      // Fall back to the device calendar day when the timezone string is invalid.
    }
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function weatherConditionKey(
  weather: Pick<LocalWeather, "weatherCode" | "observedAt" | "timezone"> | null,
  now: Date = new Date(),
  minuteForecast?: ClientMinuteForecast | null,
): string {
  if (!weather) return "";
  const day = /^\d{4}-\d{2}-\d{2}/.test(weather.observedAt)
    ? weather.observedAt.slice(0, 10)
    : formatCalendarDay(now, weather.timezone);
  const base = `${day}|${describeWeather(weather.weatherCode)}`;
  if (
    minuteForecast?.available
    && (minuteForecast.alertState === "starting-soon" || minuteForecast.alertState === "ongoing-ending")
  ) {
    return `${base}|${minuteForecast.alertState}:${(minuteForecast.precipitationType || "rain").toLowerCase()}`;
  }
  return base;
}

export function shouldAutoReadWeather(
  currentKey: string,
  lastReportedKey: string | null | undefined,
): boolean {
  return Boolean(currentKey) && currentKey !== (lastReportedKey ?? "");
}
