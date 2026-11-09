-- Request types are registered by application modules, including future extensions.
ALTER TABLE approval_request DROP CONSTRAINT approval_request_type_check;
