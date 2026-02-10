// api/weather.js
// Multi-day weather forecast using OpenWeather FREE API (5 day / 3 hour forecast)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;

    if (!OPENWEATHER_API_KEY) {
      console.error('OPENWEATHER_API_KEY not configured');
      throw new Error('API key not configured');
    }

    const { 
      check_in_date,
      check_out_date,
      property_latitude,
      property_longitude,
      property_city,
      property_state,
      property_name,
      property_id
    } = req.body;

    if (!check_in_date || !check_out_date) {
      console.warn('Missing dates');
      return res.json(getFallbackWeather(check_in_date, check_out_date, property_city));
    }

    let latitude = property_latitude;
    let longitude = property_longitude;

    // Simple validation
    if (!latitude || !longitude) {
      console.warn('Missing coordinates');
      return res.json(getFallbackWeather(check_in_date, check_out_date, property_city));
    }

    const checkinDate = new Date(check_in_date);
    const checkoutDate = new Date(check_out_date);
    const today = new Date();
    
    const daysUntilCheckin = Math.ceil((checkinDate - today) / (1000 * 60 * 60 * 24));
    const numberOfNights = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));
    const daysToShow = Math.min(numberOfNights, 5); // Free tier only gives 5 days

    console.log(`Fetching weather for ${property_city}, days: ${daysToShow}`);

    // Use FREE 5 day forecast API
    const weatherUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${latitude}&lon=${longitude}&units=imperial&appid=${OPENWEATHER_API_KEY}`;
    
    const weatherResponse = await fetch(weatherUrl);
    
    if (!weatherResponse.ok) {
      const errorText = await weatherResponse.text();
      console.error(`OpenWeather error ${weatherResponse.status}:`, errorText);
      throw new Error(`Weather API error: ${weatherResponse.status}`);
    }

    const weatherData = await weatherResponse.json();
    console.log(`Received ${weatherData.list?.length || 0} forecast entries`);

    // Group forecasts by day
    const forecastsByDay = {};
    
    weatherData.list.forEach(entry => {
      const entryDate = new Date(entry.dt * 1000);
      const dateKey = entryDate.toISOString().split('T')[0];
      
      if (!forecastsByDay[dateKey]) {
        forecastsByDay[dateKey] = [];
      }
      forecastsByDay[dateKey].push(entry);
    });

    // Build daily forecasts
    const dailyForecasts = [];
    
    for (let i = 0; i < daysToShow; i++) {
      const currentDate = new Date(checkinDate);
      currentDate.setDate(currentDate.getDate() + i);
      const dateKey = currentDate.toISOString().split('T')[0];
      
      const dayEntries = forecastsByDay[dateKey] || [];
      
      if (dayEntries.length > 0) {
        const temps = dayEntries.map(e => e.main.temp);
        const tempHigh = Math.round(Math.max(...temps));
        const tempLow = Math.round(Math.min(...temps));
        
        const precipProbs = dayEntries.map(e => e.pop || 0);
        const precipChance = Math.round(Math.max(...precipProbs) * 100);
        
        // Use midday forecast for conditions
        const middayForecast = dayEntries[Math.floor(dayEntries.length / 2)] || dayEntries[0];
        const condition = middayForecast.weather[0].description;
        
        dailyForecasts.push({
          date: dateKey,
          day_name: currentDate.toLocaleDateString('en-US', { weekday: 'long' }),
          day_short: currentDate.toLocaleDateString('en-US', { weekday: 'short' }),
          month_day: currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          is_checkin: i === 0,
          is_checkout: i === daysToShow - 1,
          temp_high: tempHigh,
          temp_low: tempLow,
          condition: condition.charAt(0).toUpperCase() + condition.slice(1),
          condition_simple: simplifyCondition(condition),
          precipitation_chance: precipChance,
          icon_url: `https://openweathermap.org/img/wn/${middayForecast.weather[0].icon}@2x.png`
        });
      }
    }

    if (dailyForecasts.length === 0) {
      console.warn('No forecasts generated');
      return res.json(getFallbackWeather(check_in_date, check_out_date, property_city));
    }

    const tempHighs = dailyForecasts.map(d => d.temp_high);
    const tempLows = dailyForecasts.map(d => d.temp_low);
    const precipChances = dailyForecasts.map(d => d.precipitation_chance);
    
    const avgHigh = Math.round(tempHighs.reduce((a, b) => a + b, 0) / tempHighs.length);
    const avgLow = Math.round(tempLows.reduce((a, b) => a + b, 0) / tempLows.length);
    const maxHigh = Math.max(...tempHighs);
    const minLow = Math.min(...tempLows);
    const avgPrecip = Math.round(precipChances.reduce((a, b) => a + b, 0) / precipChances.length);
    
    const rainyDays = dailyForecasts.filter(d => d.precipitation_chance > 40).length;

    const response = {
      success: true,
      show_weather: true,
      summary: generateSummary(dailyForecasts, avgHigh, avgLow, avgPrecip, numberOfNights, property_city),
      daily_forecasts: dailyForecasts,
      packing_recommendations: generatePackingList(maxHigh, minLow, avgPrecip, dailyForecasts),
      stats: {
        check_in_date,
        check_out_date,
        days_until_checkin: daysUntilCheckin,
        number_of_nights: numberOfNights,
        days_showing: daysToShow,
        avg_high: avgHigh,
        avg_low: avgLow,
        max_high: maxHigh,
        min_low: minLow,
        avg_precipitation: avgPrecip,
        rainy_days: rainyDays,
        has_rain: rainyDays > 0
      },
      location: {
        city: property_city || 'your destination',
        state: property_state || '',
        name: property_name || '',
        id: property_id
      }
    };

    console.log('Success! Days:', dailyForecasts.length);
    return res.json(response);

  } catch (error) {
    console.error('Error:', error.message, error.stack);
    return res.json(getFallbackWeather(
      req.body.check_in_date,
      req.body.check_out_date,
      req.body.property_city
    ));
  }
}

function simplifyCondition(condition) {
  const lower = condition.toLowerCase();
  if (lower.includes('rain') || lower.includes('drizzle')) return 'Rainy';
  if (lower.includes('snow') || lower.includes('sleet')) return 'Snow';
  if (lower.includes('thunder') || lower.includes('storm')) return 'Stormy';
  if (lower.includes('cloud') || lower.includes('overcast')) return 'Cloudy';
  if (lower.includes('clear') || lower.includes('sun')) return 'Sunny';
  if (lower.includes('few clouds') || lower.includes('scattered')) return 'Partly Cloudy';
  if (lower.includes('fog') || lower.includes('mist')) return 'Foggy';
  return 'Partly Cloudy';
}

function generateSummary(forecasts, avgHigh, avgLow, avgPrecip, nights, city) {
  let summary = `The weather for your ${nights}-night stay in ${city} will be `;
  if (avgPrecip > 50) summary += 'mostly rainy';
  else if (avgPrecip > 30) summary += 'mixed with some rain';
  else summary += 'pleasant';
  summary += ` with temperatures ranging from ${avgLow}°F to ${avgHigh}°F.`;
  return summary;
}

function generatePackingList(maxHigh, minLow, avgPrecip, forecasts) {
  const items = [];
  if (maxHigh > 85) items.push('Light, breathable clothing', 'Sunscreen and sunglasses');
  else if (maxHigh > 75) items.push('Summer clothing', 'Sunscreen');
  else if (maxHigh < 60) items.push('Warm clothing', 'Jacket or coat');
  
  if (minLow < 60) items.push('Warm layers for evenings');
  if (maxHigh - minLow > 25) items.push('Versatile layers for temperature changes');
  if (avgPrecip > 60) items.push('Rain jacket', 'Umbrella');
  else if (avgPrecip > 30) items.push('Rain jacket or umbrella');
  
  const hasSnow = forecasts.some(f => f.condition_simple === 'Snow');
  if (hasSnow) items.push('Winter boots', 'Warm coat');
  
  return [...new Set(items)].slice(0, 5);
}

function getFallbackWeather(checkInDate, checkOutDate, city) {
  return {
    success: false,
    show_weather: false,
    summary: `We hope you have wonderful weather during your stay${city ? ' in ' + city : ''}!`,
    packing_recommendations: ['Pack comfortable clothes', 'Check local forecast before departure'],
    stats: { check_in_date: checkInDate, check_out_date: checkOutDate },
    fallback: true
  };
}
