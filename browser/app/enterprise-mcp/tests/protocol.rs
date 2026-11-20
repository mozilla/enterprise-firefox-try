/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use firefox_enterprise_mcp::{read_line, Request};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn ipc_rejects_unclassified_operations_and_parameters() {
    for json in [
        json!({"operation":"evaluate", "id": 1}),
        json!({"operation":"list_tabs", "id": 1, "method":"script.evaluate"}),
        json!({"operation":"read_page", "id": 1, "tab": 10}),
    ] {
        assert!(serde_json::from_value::<Request>(json).is_err());
    }
}

#[test]
fn framing_rejects_truncated_and_oversized_input() {
    assert_eq!(
        read_line(&mut &b"abcd\n"[..], 4).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
    assert_eq!(
        read_line(&mut &b"abcd"[..], 8).unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    assert_eq!(
        read_line(&mut &b"abcd\n"[..], 5).unwrap(),
        Some(b"abcd\n".to_vec())
    );
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
fn stdio_negotiates_protocol_and_validates_calls() {
    let mut process = Command::new(env!("CARGO_BIN_EXE_firefox-enterprise-mcp"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = process.stdin.take().unwrap();
    let inputs = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-03-26",
            "clientInfo":{"name":"test-client","version":"1"},
            "capabilities":{}
        }}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
            "name":"read_page","arguments":{"tab":"1234","script":"invalid"}
        }}),
    ];
    for input in inputs {
        writeln!(stdin, "{input}").unwrap();
    }
    drop(stdin);
    let responses: Vec<Value> = BufReader::new(process.stdout.take().unwrap())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .filter(|response: &Value| response.get("id").is_some())
        .collect();

    assert!(process.wait().unwrap().success());
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(
        responses[0]["result"]["capabilities"]["tools"]["listChanged"],
        true
    );
    assert_eq!(responses[1]["error"]["code"], -32602);
}
