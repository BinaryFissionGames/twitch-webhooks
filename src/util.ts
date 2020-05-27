const TIMESTAMP_REGEX = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)\.(\d+)Z$/;

//Parses date from unix timestamp; Returns undefined if the date cannot be parsed.
function unixTimestampToDate(timestamp: string) : Date | undefined {
    let match = TIMESTAMP_REGEX.exec(timestamp);
    if (match) {
        let year = parseInt(match[1]);
        let month = parseInt(match[2]);
        let day = parseInt(match[3]);
        let hour = parseInt(match[4]);
        let minutes = parseInt(match[5]);
        let seconds = parseInt(match[6]);
        let milliseconds = parseInt(match[7]);
        return new Date(Date.UTC(year, month - 1, day, hour, minutes, seconds, milliseconds));
    }
    return undefined;
}

export {
    unixTimestampToDate
}