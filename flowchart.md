# 📊 KSPDB System Flowcharts & Sequence Diagrams

This document contains visual Mermaid flowcharts and state diagrams for the **KSPDB Power Grid Fault Detection & Localization System**, covering the end-to-end telemetry architecture, graph topology inference, fault localization, noise filtering decision tree, and ticket lifecycle.

---

## 1. End-to-End Telemetry Architecture & Ingestion Flowchart

```mermaid
flowchart TD
    subgraph FieldDevices [IoT Pole Devices & Telemetry Sources]
        A1[Standard IoT Device - FW 1.4.2] -->|HTTP POST JSON| B1
        A2[Legacy IoT Device - FW 1.2.x] -->|Heartbeat Stop| B1
        A3[Capacitor Reserve Device] -->|Power Lost Packet| B1
    end

    subgraph IngestLayer [Ingestion & Processing Pipeline]
        B1["POST /api/telemetry"] --> B2{Check device_id & seq}
        B2 -->|seq <= last_seq| B3[Ignore Duplicate Payload]
        B2 -->|seq > last_seq| B4[Update pole_state in SQLite]
        B4 --> B5[Trigger 5s Debounce Window per DT]
    end

    subgraph GraphEngine [Localization & Analysis Engine]
        B5 --> C1[Load DT Radial Tree Graph]
        C1 --> C2{Parent topology known?}
        C2 -->|Yes 40%| C3[Traverse Known Tree Graph]
        C2 -->|No 60%| C4[Infer Tree via Geometric Chaining]
        C3 --> C5[Detect Live-to-Dark Boundaries]
        C4 --> C5
    end

    subgraph NoiseFilterLayer [Noise & False Positive Filter]
        C5 --> D1{Is single dark pole with live children?}
        D1 -->|Yes| D2[Flag as Sensor Issue / Dead Modem]
        D1 -->|No| D3{Active Scheduled Outage on DT/Feeder?}
        D3 -->|Yes| D4[Suppress Alert - Planned Outage]
        D3 -->|No| D5[Generate Localized Incident Ticket]
    end

    subgraph DeliveryLayer [Presentation & Verification]
        D5 --> E1[(Save Ticket to SQLite)]
        D5 --> E2[Broadcast WebSocket Event /ws]
        E2 --> E3[Operator UI Console Update]
        
        F1[Lineman Repairs Physical Span] --> F2[Telemetry Sends power_restored]
        F2 --> F3[Auto-Verify & Close Ticket]
        F3 --> E2
    end
```

---

## 2. Fault Localization & Topology Inference Flowchart (Handling Missing 60% Topology)

```mermaid
flowchart TD
    Start([Start Fault Localization for DT]) --> GetPoles[Fetch all poles under DT]
    GetPoles --> CheckTopo{Are parent_pole_id and seq_on_line present?}

    CheckTopo -->|Yes - 40% Complete Topology| BuildKnownTree[Construct Radial Tree from parent_pole_id]
    CheckTopo -->|No - 60% Missing Topology| GeometricInfer[Run Geometric Nearest-Neighbor Chaining]

    subgraph GeometricInference [Geometric Topology Inference]
        GeometricInfer --> Step1[Locate surveyed DT GPS coordinates]
        Step1 --> Step2[Find closest pole to DT -> Root Node P1]
        Step2 --> Step3[Sequentially chain nearest unvisited poles]
        Step3 --> Step4{Distance > 1.8x median spacing?}
        Step4 -->|Yes| Step5[Search earlier poles -> Create Spur Branch]
        Step4 -->|No| Step6[Continue Main Line Chain]
        Step5 & Step6 --> MarkInferred[Flag Topology as Inferred - Confidence ~60%]
    end

    BuildKnownTree & MarkInferred --> TraverseTree[Traverse Tree from DT Root]

    TraverseTree --> ScanBoundary{Parent Node Live & Child Node Dark?}
    ScanBoundary -->|No Boundary| NextNode[Check Next Edge]
    ScanBoundary -->|Boundary Found| FlagSpan[Mark Edge as Fault Span]

    FlagSpan --> GroupDark[Group ALL downstream dark poles into ONE Incident]
    GroupDark --> CalculateConfidence[Calculate Confidence & Extract PIN Code + Coordinates]
    CalculateConfidence --> OutputTicket([Output Single Localized Ticket])
```

---

## 3. Noise Filtering & False-Positive Decision Tree

```mermaid
flowchart TD
    InputDark[Pole Reported Dark / Missed Heartbeats] --> CheckNeighbors{Are downstream child poles live?}
    
    CheckNeighbors -->|Yes| DeadSensor[Flag as DEAD SENSOR / MODEM ISSUE]
    DeadSensor --> NoTicket1[Do NOT create Fault Ticket]

    CheckNeighbors -->|No| CheckScheduledOutage{Matches Active Scheduled Outage window?}
    
    CheckScheduledOutage -->|Yes within window or 40m overrun| SuppressedOutage[Suppress Alert: Planned Maintenance]
    SuppressedOutage --> NoTicket2[Do NOT create Fault Ticket]

    CheckScheduledOutage -->|No| CheckDebounce{Has 5-second debounce window passed?}
    
    CheckDebounce -->|No| WaitDebounce[Buffer telemetry in memory]
    CheckDebounce -->|Yes| CreateTicket[Create Localized Incident Ticket]
```

---

## 4. Ticket Lifecycle & Telemetry-Verified Closure State Machine

```mermaid
stateDiagram-v2
    [*] --> DETECTED: Span/DT/Feeder Fault Detected

    DETECTED --> ACKNOWLEDGED: Operator clicks Acknowledge in UI
    ACKNOWLEDGED --> CREW_ASSIGNED: Crew dispatched to physical span

    state ManualGuard {
        CREW_ASSIGNED --> RESOLVED_ATTEMPT: Lineman clicks 'Mark Resolved'
        RESOLVED_ATTEMPT --> REJECTED: Telemetry shows poles STILL DARK
        REJECTED --> CREW_ASSIGNED: Rejects action & shows warning
    }

    CREW_ASSIGNED --> VERIFIED: Telemetry receives 'power_restored' signals
    VERIFIED --> CLOSED: Ticket Auto-Verified & Closed
    CLOSED --> [*]
```
