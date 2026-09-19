/**
 * Temperature conversion + formatting. Storage standard is Celsius; the user picks
 * Celsius or Fahrenheit for display via preferences.
 */

export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9 / 5) + 32;
}

/** Convert Celsius (storage standard) to the user's preferred unit. */
export function convertTemperature(celsius: number, unit: 'C' | 'F'): number {
  if (unit === 'F') {
    return celsiusToFahrenheit(celsius);
  }
  return celsius;
}

/** Format a Celsius value in the user's unit, e.g. "45.0°C" or "113.0°F". */
export function formatTemperature(
  celsius: number,
  unit: 'C' | 'F',
  decimals: number = 1
): string {
  const converted = convertTemperature(celsius, unit);
  const rounded = converted.toFixed(decimals);
  return `${rounded}°${unit}`;
}

/**
 * Temperature status for colour coding. Thresholds follow typical hardware safe
 * operating ranges: normal < 70°C, warning 70-85°C, critical > 85°C.
 */
export function getTemperatureStatus(celsius: number): 'normal' | 'warning' | 'critical' {
  if (celsius < 70) {
    return 'normal';
  } else if (celsius < 85) {
    return 'warning';
  } else {
    return 'critical';
  }
}

/**
 * Tailwind text-colour classes for the temperature status. Normal returns no class:
 * colour is reserved for crossed thresholds, so a green wall of numbers can't hide them.
 */
export function getTemperatureColorClass(celsius: number): string {
  const status = getTemperatureStatus(celsius);

  switch (status) {
    case 'normal':
      return '';
    case 'warning':
      return 'text-yellow-500';
    case 'critical':
      return 'text-red-500';
  }
}
