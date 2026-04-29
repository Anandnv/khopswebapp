# 🏥 KH ERP – Cardiology Operations Management System

## 📌 Overview

KH ERP is an internal enterprise web application developed for managing and monitoring multi-centre cardiology operations. It provides real-time tracking of daily activities, procedures, financials, and performance across all centres within the organization.

The system is designed to improve **operational visibility, accountability, and data accuracy**.

---

## 🎯 Core Purpose

* Centralized tracking of all cardiology centres
* Daily operational data entry and monitoring
* Performance analysis against targets
* Financial tracking (petty cash)
* Controlled data editing with audit logs

---

## 👥 User Roles

### 🔴 Super Admin

* Full system control
* Create/manage admins
* Assign centres
* Access all data and logs

### 🔵 Admin

* Monitor all assigned centres
* Approve/reject unlock requests
* View reports and audit logs
* Track performance and targets

### 🟢 Centre User

* Enter daily operational data
* Submit procedures and OP metrics
* Request edits for locked dates
* Manage petty cash entries

---

## 🏢 Centre Management

* Multiple centres supported (Tirur, Calicut, Kochi, etc.)
* Each centre has:

  * Login credentials
  * Monthly targets
  * Performance metrics
  * Case Classification tracking

---

## 🏥 Operations Module

### 📊 Daily Entry System

Each centre records:

#### OP Metrics:

* Total OP
* IP
* New OP
* ECG
* ECHO
* TMT

#### Procedures:

* CAG
* PTCA
* POBA
* PTA
* PPI / TPI
* Device Closure
* Other cardiology procedures

#### Case Classification:

* General
* KASP
* MEDISEP

#### Referrals:

* OP / ECG / ECHO / TMT
* CAG / PTCA / Others

---

## 📈 Performance Dashboard

### Consolidated View:

* Till Yesterday
* Today
* Total Performance
* Target vs Achievement (%)
* CAG Tracking
* Case Classifications

### Visual Insights:

* Achievement progress bars
* Status indicators (Good / Watch / Risk)
* Donut chart for payer distribution

---

## 🚨 Pending Submission Alert

* Shows centres that have not submitted daily data
* Real-time tracking for admin visibility
* Status:

  * ✅ Updated
  * ❌ Pending

---

## 🔐 Date Lock & Unlock System

### Rules:

* Today → Editable
* Past Dates → Locked

### Unlock Workflow:

1. Centre requests edit
2. Admin reviews request
3. Admin approves/rejects
4. Temporary edit window provided

---

## 📜 Audit Log System

Tracks all changes in the system:

* Before & after values
* User who made the change
* Timestamp
* Change type:

  * Normal edit
  * Unlocked edit
  * Revert action

---

## 🔄 Revert System

* Admin can restore previous versions of data
* Automatically logs revert actions
* Ensures data integrity and traceability

---

## 💰 Petty Cash Module

### Features:

* Monthly opening balance
* Daily entries:

  * Receipts
  * Payments
* Running balance calculation
* Centre-wise tracking

### Controls:

* Centre → Add/Edit entries
* Admin → View only

---

## 📤 Petty Cash Export

* Excel (.xlsx) download
* Includes:

  * Running balance formulas
  * Currency formatting
  * Structured ledger

---

## 📣 Swizton Marketing Module

Tracks marketing funnel performance:

### Lead Metrics:

* Leads generated
* Genuine leads
* Invalid leads

### Conversion Tracking:

* OP booked
* OP seen
* Advices
* Procedures done

### Dual Tracking:

* UFE
* Vericose

---

## 📊 Swizton Dashboard

* Campaign-wise performance
* Conversion ratios:

  * Leads → OP
  * OP → Procedure
* Consolidated monthly view

---

## ⚙️ Procedure Configuration

* Add/remove procedures dynamically
* Mark:

  * Counted procedures
  * CAG-specific procedures
  * Active/inactive

---

## 📊 Reporting System

### Available Reports:

* Daily report
* Consolidated report
* Centre-wise performance

### Includes:

* Procedures
* OP metrics
* Payer breakdown

---

## 💾 Data Management

### Storage Layers:

* Supabase (Primary database)
* LocalStorage (Backup/cache)

### Features:

* Automatic save
* Backup system
* Restore capability

---

## 🗄️ Database Structure

### Tables:

* `app_config` → Centres, procedures, settings
* `daily_entries` → Daily centre data
* `entry_meta` → Save tracking
* `unlock_requests` → Edit approvals
* `audit_log` → Change tracking
* `app_backups` → System backups

---

## 🔄 Migration Support

* Legacy JSON data migration to structured tables
* Safe re-run migration scripts
* Conflict handling with upsert logic

---

## 🔐 Security Features

* Password hashing (SHA-256)
* Login rate limiting
* Session management
* Role-based access control

---

## ⚡ Key Highlights

* Multi-centre operations tracking
* Strong audit & control system
* Real-time performance monitoring
* Built-in financial tracking
* Excel export capability
* Marketing + operations integration

---

## 🚀 Deployment

### Recommended Stack:

* Frontend: HTML, CSS, JavaScript
* Backend: Supabase
* Hosting: Vercel

---

## 📌 Future Enhancements

* Mobile optimization
* Advanced reporting (PDF)
* Notification system
* Role-based dashboards
* Improved authentication system

---
## 🧑‍💻 Author

Anand Nv
Assistant Manager – Operations
Karunya Hrudayalaya

## 🧠 Author Notes

This system is designed specifically for internal use within Karunya Hrudayalaya to streamline cardiology operations and improve decision-making through accurate, real-time data.

---
