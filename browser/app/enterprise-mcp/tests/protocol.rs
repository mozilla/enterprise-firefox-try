/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use firefox_enterprise_mcp::{read_line, Request};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

static CONNECTOR_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn ipc_rejects_unclassified_operations_and_parameters() {
    for json in [
        json!({"operation":"evaluate", "id": 1}),
        json!({"operation":"list_tabs", "id": 1, "method":"script.evaluate"}),
        json!({"operation":"read_page", "id": 1, "tab": 10}),
        json!({"operation":"open_tab", "id": 1, "url":"https://example.com/", "headers":{}}),
        json!({"operation":"navigate_tab", "id": 1, "url":"https://example.com/"}),
        json!({"operation":"interact", "id":1, "tab":"a", "element":"b", "action":{"type":"click","selector":"button"}}),
        json!({"operation":"interact", "id":1, "tab":"a", "element":"b", "action":{"type":"select","index":-1}}),
        json!({"operation":"interact", "id":1, "tab":"a", "element":"b", "action":{"type":"script"}}),
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
    let _serial = CONNECTOR_TESTS.lock().unwrap();
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
        json!({"jsonrpc":"2.0","id":"unknown","result":{}}),
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

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
fn approved_connector_forwards_only_the_peer_bound_challenge() {
    use firefox_enterprise_mcp::{encode, local::Listener, Capabilities, Event, MAX_RESPONSE};
    use std::{
        io::{self, Read},
        thread,
        time::{Duration, Instant},
    };

    fn wait<T>(mut attempt: impl FnMut() -> io::Result<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match attempt() {
                Ok(value) => return value,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("{error}"),
            }
        }
    }

    let _serial = CONNECTOR_TESTS.lock().unwrap();
    let mut listener = Listener::bind().unwrap();
    let mut connector = Command::new(env!("CARGO_BIN_EXE_firefox-enterprise-mcp"))
        .arg("--external-signer")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = connector.stdin.take().unwrap();
    let mut output = BufReader::new(connector.stdout.take().unwrap());
    let mut receive = || {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-11-25",
            "clientInfo":{"name":"test-client","version":"1"},
            "capabilities":{}
        }})
    )
    .unwrap();
    assert_eq!(receive()["id"], 1);
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .unwrap();
    let mut stream = wait(|| listener.accept());
    assert_eq!(stream.peer_pid().unwrap(), connector.id());
    let payload = serde_json::to_string(&(
        "firefox-enterprise-mcp:v1",
        "A".repeat(43),
        std::process::id(),
        connector.id(),
    ))
    .unwrap();
    stream
        .write_all(
            &encode(
                &Event::Challenge {
                    payload: payload.clone(),
                },
                MAX_RESPONSE,
            )
            .unwrap(),
        )
        .unwrap();
    let signature = "A".repeat(86);
    let challenge = receive();
    assert_eq!(challenge["method"], "firefoxEnterprise/signChallenge");
    assert_eq!(challenge["params"]["payload"], payload);
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":challenge["id"],
               "result":{"key_id":"enrolled","signature":signature}})
    )
    .unwrap();
    let mut incoming = Vec::new();
    wait(|| {
        let mut bytes = [0; 256];
        let size = stream.read(&mut bytes)?;
        assert_ne!(size, 0);
        incoming.extend_from_slice(&bytes[..size]);
        if incoming.ends_with(b"\n") {
            Ok(())
        } else {
            Err(io::ErrorKind::WouldBlock.into())
        }
    });
    let request: Request = serde_json::from_slice(&incoming).unwrap();
    assert!(matches!(
        request,
        Request::Authenticate { key_id, signature: proof }
            if key_id == "enrolled" && proof == signature
    ));
    stream
        .write_all(
            &encode(
                &Event::Ready {
                    capabilities: Capabilities::default(),
                },
                MAX_RESPONSE,
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(receive()["method"], "notifications/tools/list_changed");
    drop(input);
    assert!(connector.wait().unwrap().success());
}
