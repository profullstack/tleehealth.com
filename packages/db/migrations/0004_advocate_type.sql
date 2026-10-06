-- Patient advocates (navigators): trained staff who work a caseload under a
-- clinician's direction, log their time and run care plans. A billed seat.
--
-- Its own file because Postgres cannot use an enum value in the transaction that
-- adds it; 0005 makes the seat billable.
alter type user_type add value if not exists 'advocate' after 'staff';
