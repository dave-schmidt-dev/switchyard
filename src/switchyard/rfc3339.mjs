const RFC3339_RE =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-](\d{2}):(\d{2}))$/u;

/** Parse an RFC3339 timestamp, rejecting components Date.parse would normalize. */
export function parseRfc3339(value) {
	if (typeof value !== "string") return null;
	const match = RFC3339_RE.exec(value);
	if (!match) return null;
	const [
		,
		yearText,
		monthText,
		dayText,
		hourText,
		minuteText,
		secondText,
		fraction,
		zone,
		offsetHourText,
		offsetMinuteText,
	] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysByMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	const offsetHour = Number(offsetHourText ?? 0);
	const offsetMinute = Number(offsetMinuteText ?? 0);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysByMonth[month - 1] ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59
	) {
		return null;
	}
	const normalizedFraction = fraction
		? `.${fraction.slice(0, 3).padEnd(3, "0")}`
		: "";
	const normalizedValue = `${value.slice(0, 19).replace("t", "T")}${normalizedFraction}${zone.toUpperCase()}`;
	const epochMs = Date.parse(normalizedValue);
	if (!Number.isFinite(epochMs)) return null;
	return {
		epochMs,
		hasSubMillisecondRemainder: /[1-9]/u.test(fraction?.slice(3) ?? ""),
	};
}
