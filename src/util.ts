const TIMESTAMP_REGEX = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)\.(\d+)Z$/;

//Parses date from unix timestamp; Returns undefined if the date cannot be parsed.
function unixTimestampToDate(timestamp: string) : Date | undefined {
    let match = TIMESTAMP_REGEX.exec(timestamp);
    if (match && match.groups) {
        let year = parseInt(match.groups[1]);
        let month = parseInt(match.groups[2]);
        let day = parseInt(match.groups[3]);
        let hour = parseInt(match.groups[4]);
        let minutes = parseInt(match.groups[5]);
        let seconds = parseInt(match.groups[6]);
        let milliseconds = parseInt(match.groups[7]);
        return new Date(Date.UTC(year, month - 1, day, hour, minutes, seconds, milliseconds));
    }
    return undefined;
}