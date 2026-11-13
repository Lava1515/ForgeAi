// The one place the host output producer gets its process-starting function from. The CB5 engine folder
// (engines/codebuilt) is kept free of any process surface (a test scans it), so the composition passes this in.
// The producer calls it with a fixed argv and shell:false; it never starts the generated code, only the post kit.
export { execFile as hostExecFile } from 'node:child_process';
