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

export function weatherBriefing(weather: LocalWeather | null, forecast: WeatherForecastDay[]) {
  if (!weather) return "";
  const place = weather.locationName ? ` for ${weather.locationName}` : "";
  const current = `Here is your weather${place}. Currently, ${describeWeather(weather.weatherCode).toLowerCase()}, ${Math.round(weather.temperature)} degrees Celsius, feeling like ${Math.round(weather.apparentTemperature)} degrees. Wind is ${Math.round(weather.windSpeed)} kilometres per hour.`;
  // Open-Meteo's local observation date matches the forecast location, even
  // when the device is in a different timezone. Never read tomorrow as today.
  const today = forecast.find((day) => day.date === weather.observedAt.slice(0, 10));
  if (!today) return current;
  return `${current} Today, expect ${describeWeather(today.weatherCode).toLowerCase()}, with a high of ${Math.round(today.temperatureMax)} and a low of ${Math.round(today.temperatureMin)} degrees Celsius. The chance of rain is ${Math.round(today.precipitationProbability)} percent.`;
}
