import { ForecastGraphic } from "./components/ForecastGraphic";
import { WeatherIntro } from "./components/WeatherIntro";

export default function Home() {
  return (
    <>
      <ForecastGraphic />
      <WeatherIntro />
    </>
  );
}
