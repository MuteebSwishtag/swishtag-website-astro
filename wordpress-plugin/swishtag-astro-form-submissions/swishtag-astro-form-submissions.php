<?php
/**
 * Plugin Name: Swishtag Astro Form Submissions
 * Description: Connects the Swishtag Astro site to WordPress form submissions and published portfolio content.
 * Version: 1.1.0
 * Author: Swishtag
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Text Domain: swishtag-astro-form-submissions
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

final class Swishtag_Astro_Form_Submissions
{
    private const POST_TYPE = 'st_form_submission';
    private const REST_NAMESPACE = 'astro-form/v1';
    private const REST_ROUTE = '/submit';
    private const TOKEN_OPTION = 'swishtag_astro_form_token';
    private const RATE_LIMIT_WINDOW = 10 * MINUTE_IN_SECONDS;
    private const RATE_LIMIT_MAX = 5;

    public static function init(): void
    {
        add_filter('register_post_type_args', [self::class, 'expose_portfolio_in_rest'], 10, 2);
        add_action('init', [self::class, 'register_post_type']);
        add_action('rest_api_init', [self::class, 'register_rest_route']);
        add_filter('rest_pre_dispatch', [self::class, 'handle_preflight'], 10, 3);
        add_filter('manage_' . self::POST_TYPE . '_posts_columns', [self::class, 'manage_columns']);
        add_action('manage_' . self::POST_TYPE . '_posts_custom_column', [self::class, 'render_column'], 10, 2);
        add_filter('manage_edit-' . self::POST_TYPE . '_sortable_columns', [self::class, 'sortable_columns']);
        add_action('pre_get_posts', [self::class, 'admin_orderby']);
        add_filter('posts_search', [self::class, 'admin_search_meta'], 10, 2);
        add_action('add_meta_boxes', [self::class, 'add_meta_boxes']);
    }

    /**
     * Expose Salient's public portfolio post type to the headless Astro site.
     * WordPress still requires authentication for create, update, and delete requests.
     */
    public static function expose_portfolio_in_rest(array $args, string $post_type): array
    {
        if ($post_type !== 'portfolio') {
            return $args;
        }

        $args['show_in_rest'] = true;
        $args['rest_base'] = 'portfolio';
        $args['rest_namespace'] = 'wp/v2';
        $args['rest_controller_class'] = 'WP_REST_Posts_Controller';

        return $args;
    }

    public static function activate(): void
    {
        if (!get_option(self::TOKEN_OPTION)) {
            add_option(self::TOKEN_OPTION, wp_generate_password(40, false, false), '', false);
        }

        self::register_post_type();
        flush_rewrite_rules();
    }

    public static function deactivate(): void
    {
        flush_rewrite_rules();
    }

    public static function register_post_type(): void
    {
        register_post_type(self::POST_TYPE, [
            'labels' => [
                'name' => 'Form Submissions',
                'singular_name' => 'Form Submission',
                'menu_name' => 'Form Submissions',
                'name_admin_bar' => 'Form Submission',
                'search_items' => 'Search Form Submissions',
                'not_found' => 'No form submissions found.',
                'not_found_in_trash' => 'No form submissions found in Trash.',
                'edit_item' => 'View Form Submission',
                'view_item' => 'View Form Submission',
                'all_items' => 'Form Submissions',
            ],
            'public' => false,
            'show_ui' => true,
            'show_in_menu' => true,
            'show_in_admin_bar' => false,
            'show_in_rest' => false,
            'exclude_from_search' => true,
            'menu_icon' => 'dashicons-email-alt2',
            'supports' => ['title'],
            'capability_type' => 'post',
            'map_meta_cap' => true,
            'capabilities' => [
                'create_posts' => 'do_not_allow',
            ],
        ]);
    }

    public static function register_rest_route(): void
    {
        register_rest_route(self::REST_NAMESPACE, self::REST_ROUTE, [
            [
                'methods' => WP_REST_Server::CREATABLE,
                'callback' => [self::class, 'submit'],
                'permission_callback' => [self::class, 'can_submit'],
            ],
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => static function (): WP_REST_Response {
                    return self::json_response(false, 'This endpoint accepts POST form submissions only.', 405);
                },
                'permission_callback' => '__return_true',
            ],
            [
                'methods' => 'OPTIONS',
                'callback' => static function (): WP_REST_Response {
                    return new WP_REST_Response(null, 204);
                },
                'permission_callback' => '__return_true',
            ],
        ]);
    }

    public static function handle_preflight($result, WP_REST_Server $server, WP_REST_Request $request)
    {
        if (!self::is_form_route($request)) {
            return $result;
        }

        self::send_cors_headers();

        if ($request->get_method() === 'OPTIONS') {
            $origin = self::request_origin();
            if ($origin !== '' && !self::is_allowed_origin($origin)) {
                return self::json_response(false, 'This origin is not allowed to submit this form.', 403);
            }

            return new WP_REST_Response(null, 204);
        }

        return $result;
    }

    public static function can_submit(WP_REST_Request $request)
    {
        self::send_cors_headers();

        $origin = self::request_origin();
        if ($origin !== '' && !self::is_allowed_origin($origin)) {
            return new WP_Error(
                'astro_form_forbidden_origin',
                'This origin is not allowed to submit this form.',
                ['status' => 403]
            );
        }

        $configured_token = self::submission_token();
        if ($configured_token === '') {
            return new WP_Error(
                'astro_form_not_configured',
                'The form submission token is not configured in WordPress.',
                ['status' => 500]
            );
        }

        $provided_token = self::request_token($request);
        if ($provided_token === '' || !hash_equals($configured_token, $provided_token)) {
            return new WP_Error(
                'astro_form_bad_token',
                'This form could not be verified. Please refresh and try again.',
                ['status' => 403]
            );
        }

        return true;
    }

    public static function submit(WP_REST_Request $request): WP_REST_Response
    {
        $data = $request->get_json_params();
        if (!is_array($data) || $data === []) {
            $data = $request->get_body_params();
        }

        if (!is_array($data) || $data === []) {
            return self::json_response(false, 'Please complete the form and try again.', 400);
        }

        $source = self::clean_text($data['form_source'] ?? $data['source'] ?? '', 80);
        $honeypot = self::clean_text($data['nickname'] ?? $data['_gotcha'] ?? '', 120);
        if ($honeypot !== '') {
            return self::json_response(true, 'Thanks. Your request has been received.', 200);
        }

        if (!in_array($source, ['book-demo', 'custom-software', 'contact'], true)) {
            return self::json_response(false, 'This form could not be verified. Please refresh and try again.', 400);
        }

        $rate_limit = self::check_rate_limit($source, $data);
        if (is_wp_error($rate_limit)) {
            return self::json_response(false, $rate_limit->get_error_message(), 429);
        }

        if (self::submitted_too_fast($data)) {
            return self::json_response(false, 'Please wait a moment before submitting the form.', 422);
        }

        if (self::has_too_many_links($data)) {
            return self::json_response(false, 'Please remove extra links before submitting the form.', 422);
        }

        $normalized = self::normalize_submission($source, $data);
        if (is_wp_error($normalized)) {
            return self::json_response(false, $normalized->get_error_message(), (int) $normalized->get_error_data('status') ?: 422);
        }

        $post_id = self::save_submission($source, $normalized);
        if (is_wp_error($post_id)) {
            return self::json_response(false, 'We could not save your submission right now. Please try again.', 500);
        }

        $mail_sent = self::send_admin_email((int) $post_id, $source, $normalized);
        update_post_meta((int) $post_id, 'astro_form_email_sent', $mail_sent ? 'yes' : 'no');

        $message = $source === 'book-demo'
            ? 'Thanks. Your demo request has been sent to Swishtag.'
            : ($source === 'contact'
                ? 'Thanks. Your inquiry has been sent to Swishtag.'
                : 'Thanks. Your idea has been sent to Swishtag.');

        return new WP_REST_Response([
            'ok' => true,
            'message' => $message,
            'submission_id' => (int) $post_id,
            'email_sent' => $mail_sent,
        ], 200);
    }

    public static function manage_columns(array $columns): array
    {
        unset($columns['date']);

        if ($source === 'contact') {
            return [
                'form_source' => ['label' => 'Form source', 'required' => true, 'max' => 80],
                'fullName' => ['label' => 'Full name', 'required' => true, 'max' => 160],
                'firstName' => ['label' => 'First name', 'required' => true, 'max' => 100],
                'lastName' => ['label' => 'Last name', 'required' => true, 'max' => 100],
                'workEmail' => ['label' => 'Work email', 'type' => 'email', 'required' => true, 'max' => 254],
                'companyName' => ['label' => 'Company', 'required' => true, 'max' => 160],
                'role' => [
                    'label' => 'Role',
                    'required' => true,
                    'max' => 180,
                    'choices' => [
                        'Promotional Products Distributor',
                        'Promotional Products Supplier',
                        'Promotional Products Decorator',
                        'Brand / Enterprise Buyer',
                        'Technology Partner',
                        'Other',
                    ],
                ],
                'topic' => [
                    'label' => 'Topic',
                    'required' => true,
                    'max' => 180,
                    'choices' => [
                        'Shopify Company Store',
                        'SAGE + Shopify',
                        'Enterprise Company Store Automation',
                        'PunchOut',
                        'Custom Software & Automation',
                        'System Integration',
                        'Promo Plus',
                        'Xecutor',
                        'Rocket Apps',
                        'Partnership Opportunity',
                        'General Inquiry',
                        'Something Else',
                    ],
                ],
                'message' => ['label' => 'Message', 'type' => 'textarea', 'required' => true, 'max' => 3000],
                'page' => ['label' => 'Page', 'type' => 'url', 'max' => 500],
                'form_loaded_at' => ['label' => 'Form loaded at', 'max' => 40],
            ];
        }

        return [
            'cb' => $columns['cb'] ?? '',
            'title' => 'Submission',
            'astro_form_source' => 'Form',
            'astro_form_name' => 'Name',
            'astro_form_email' => 'Email',
            'astro_form_company' => 'Company',
            'astro_form_received' => 'Received',
            'astro_form_email_sent' => 'Email',
        ];
    }

    public static function render_column(string $column, int $post_id): void
    {
        switch ($column) {
            case 'astro_form_source':
                echo esc_html(self::source_label((string) get_post_meta($post_id, 'astro_form_source', true)));
                break;
            case 'astro_form_name':
                echo esc_html((string) get_post_meta($post_id, 'astro_form_name', true));
                break;
            case 'astro_form_email':
                $email = (string) get_post_meta($post_id, 'astro_form_email', true);
                echo $email !== '' ? '<a href="mailto:' . esc_attr($email) . '">' . esc_html($email) . '</a>' : '&mdash;';
                break;
            case 'astro_form_company':
                echo esc_html((string) get_post_meta($post_id, 'astro_form_company', true) ?: '-');
                break;
            case 'astro_form_received':
                echo esc_html(get_the_date('M j, Y g:i a', $post_id));
                break;
            case 'astro_form_email_sent':
                echo esc_html(get_post_meta($post_id, 'astro_form_email_sent', true) === 'yes' ? 'Sent' : 'Not sent');
                break;
        }
    }

    public static function sortable_columns(array $columns): array
    {
        $columns['astro_form_received'] = 'date';
        return $columns;
    }

    public static function admin_orderby(WP_Query $query): void
    {
        if (!is_admin() || !$query->is_main_query() || $query->get('post_type') !== self::POST_TYPE) {
            return;
        }

        if (!$query->get('orderby')) {
            $query->set('orderby', 'date');
            $query->set('order', 'DESC');
        }
    }

    public static function admin_search_meta(string $search, WP_Query $query): string
    {
        if (!is_admin() || !$query->is_main_query() || $query->get('post_type') !== self::POST_TYPE) {
            return $search;
        }

        $term = trim((string) $query->get('s'));
        if ($term === '') {
            return $search;
        }

        global $wpdb;
        $like = '%' . $wpdb->esc_like($term) . '%';

        return $wpdb->prepare(
            " AND ({$wpdb->posts}.post_title LIKE %s OR {$wpdb->posts}.ID IN (
                SELECT post_id FROM {$wpdb->postmeta}
                WHERE meta_key LIKE 'astro_form_%' AND meta_value LIKE %s
            ))",
            $like,
            $like
        );
    }

    public static function add_meta_boxes(): void
    {
        add_meta_box(
            'swishtag-astro-form-fields',
            'Submitted Fields',
            [self::class, 'render_fields_meta_box'],
            self::POST_TYPE,
            'normal',
            'high'
        );

        add_meta_box(
            'swishtag-astro-form-details',
            'Submission Details',
            [self::class, 'render_details_meta_box'],
            self::POST_TYPE,
            'side',
            'default'
        );
    }

    public static function render_fields_meta_box(WP_Post $post): void
    {
        $fields = get_post_meta($post->ID, 'astro_form_payload', true);
        if (!is_array($fields)) {
            $fields = [];
        }

        echo '<table class="widefat striped"><tbody>';
        foreach ($fields as $key => $field) {
            if (!is_array($field)) {
                continue;
            }

            $label = (string) ($field['label'] ?? $key);
            $value = (string) ($field['value'] ?? '');
            echo '<tr>';
            echo '<th style="width:32%;vertical-align:top;">' . esc_html($label) . '</th>';
            echo '<td style="white-space:pre-wrap;">' . esc_html($value !== '' ? $value : '-') . '</td>';
            echo '</tr>';
        }
        echo '</tbody></table>';
    }

    public static function render_details_meta_box(WP_Post $post): void
    {
        $details = [
            'Form' => self::source_label((string) get_post_meta($post->ID, 'astro_form_source', true)),
            'Email sent' => get_post_meta($post->ID, 'astro_form_email_sent', true) === 'yes' ? 'Yes' : 'No',
            'Submitted' => get_the_date('M j, Y g:i a', $post),
            'IP' => (string) get_post_meta($post->ID, 'astro_form_ip', true),
            'User agent' => (string) get_post_meta($post->ID, 'astro_form_user_agent', true),
        ];

        echo '<ul>';
        foreach ($details as $label => $value) {
            echo '<li><strong>' . esc_html($label) . ':</strong><br>' . esc_html($value !== '' ? $value : '-') . '</li>';
        }
        echo '</ul>';
    }

    private static function is_form_route(WP_REST_Request $request): bool
    {
        return $request->get_route() === '/' . self::REST_NAMESPACE . self::REST_ROUTE;
    }

    private static function send_cors_headers(): void
    {
        $origin = self::request_origin();
        if ($origin !== '' && self::is_allowed_origin($origin)) {
            header('Access-Control-Allow-Origin: ' . esc_url_raw($origin));
            header('Vary: Origin', false);
        }

        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, X-Astro-Form-Token');
        header('Access-Control-Max-Age: 600');
    }

    private static function request_origin(): string
    {
        $origin = get_http_origin();
        return is_string($origin) ? untrailingslashit($origin) : '';
    }

    private static function is_allowed_origin(string $origin): bool
    {
        $allowed = self::allowed_origins();
        return in_array(untrailingslashit($origin), $allowed, true);
    }

    private static function allowed_origins(): array
    {
        $origins = [];

        if (defined('ASTRO_FORM_ALLOWED_ORIGINS')) {
            $origins = array_map('trim', explode(',', (string) ASTRO_FORM_ALLOWED_ORIGINS));
        }

        if ($origins === []) {
            $origins = [
                home_url('', 'https'),
                site_url('', 'https'),
                'https://cms.swishtag.com',
                'https://www.swishtag.com',
            ];
        }

        if (defined('WP_DEBUG') && WP_DEBUG) {
            $origins[] = 'http://localhost:4321';
            $origins[] = 'http://127.0.0.1:4321';
        }

        $origins = array_map(static function (string $origin): string {
            return untrailingslashit(trim($origin));
        }, $origins);

        return array_values(array_unique(array_filter($origins)));
    }

    private static function submission_token(): string
    {
        if (defined('ASTRO_FORM_TOKEN')) {
            return trim((string) ASTRO_FORM_TOKEN);
        }

        return trim((string) get_option(self::TOKEN_OPTION, ''));
    }

    private static function request_token(WP_REST_Request $request): string
    {
        $token = $request->get_header('x_astro_form_token');
        if (!is_string($token) || $token === '') {
            $token = $request->get_param('astro_form_token');
        }

        return is_scalar($token) ? trim((string) $token) : '';
    }

    private static function check_rate_limit(string $source, array $data)
    {
        $ip = self::request_ip();
        $email = self::clean_email($data['workEmail'] ?? $data['email'] ?? '');
        $identity = $ip . '|' . $source . '|' . strtolower($email);
        $key = 'astro_form_rate_' . md5($identity);
        $count = (int) get_transient($key);

        if ($count >= self::RATE_LIMIT_MAX) {
            return new WP_Error('astro_form_rate_limited', 'Too many submissions. Please wait a few minutes and try again.');
        }

        set_transient($key, $count + 1, self::RATE_LIMIT_WINDOW);
        return true;
    }

    private static function submitted_too_fast(array $data): bool
    {
        $loaded_at = isset($data['form_loaded_at']) && is_scalar($data['form_loaded_at'])
            ? (int) $data['form_loaded_at']
            : 0;

        if ($loaded_at <= 0) {
            return false;
        }

        $elapsed_ms = (int) round(microtime(true) * 1000) - $loaded_at;
        return $elapsed_ms > 0 && $elapsed_ms < 2500;
    }

    private static function has_too_many_links(array $data): bool
    {
        $text = '';
        foreach ($data as $value) {
            if (is_scalar($value)) {
                $text .= ' ' . (string) $value;
            }
        }

        preg_match_all('/https?:\/\/|www\./i', $text, $matches);
        return count($matches[0]) > 5;
    }

    private static function normalize_submission(string $source, array $data)
    {
        $schema = self::field_schema($source);
        $normalized = [];

        foreach ($schema as $key => $config) {
            $value = $data[$key] ?? '';
            $type = (string) ($config['type'] ?? 'text');
            $max = (int) ($config['max'] ?? 300);

            if ($type === 'email') {
                $value = self::clean_email($value);
            } elseif ($type === 'url') {
                $raw = self::clean_text($value, $max);
                $value = self::normalize_url($raw);
                if ($raw !== '' && $value === '') {
                    return new WP_Error('astro_form_invalid_url', 'Please enter a valid website like google.com or www.google.com.', ['status' => 422]);
                }
            } elseif ($type === 'textarea') {
                $value = self::clean_textarea($value, $max);
            } else {
                $value = self::clean_text($value, $max);
            }

            if (!empty($config['required']) && $value === '') {
                return new WP_Error('astro_form_missing_field', 'Please complete all required fields before submitting.', ['status' => 422]);
            }

            if ($type === 'email' && $value !== '' && !is_email($value)) {
                return new WP_Error('astro_form_invalid_email', 'Please enter a valid work email address.', ['status' => 422]);
            }

            if (!empty($config['choices']) && $value !== '' && !in_array($value, (array) $config['choices'], true)) {
                return new WP_Error('astro_form_invalid_choice', 'One of the selected form options is not valid. Please refresh and try again.', ['status' => 422]);
            }

            if ($key === 'selectedDateISO' && $value !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
                return new WP_Error('astro_form_invalid_date', 'Please choose a valid date for your demo.', ['status' => 422]);
            }

            $normalized[$key] = [
                'label' => (string) ($config['label'] ?? $key),
                'value' => $value,
            ];
        }

        return $normalized;
    }

    private static function field_schema(string $source): array
    {
        if ($source === 'book-demo') {
            return [
                'form_source' => ['label' => 'Form source', 'required' => true, 'max' => 80],
                'fullName' => ['label' => 'Full name', 'required' => true, 'max' => 160],
                'workEmail' => ['label' => 'Work email', 'type' => 'email', 'required' => true, 'max' => 254],
                'companyName' => ['label' => 'Company', 'required' => true, 'max' => 160],
                'website' => ['label' => 'Website', 'type' => 'url', 'max' => 300],
                'solutionInterest' => [
                    'label' => 'Solution interest',
                    'required' => true,
                    'max' => 180,
                    'choices' => [
                        'Company Store Launch',
                        'SAGE Connected Company Store',
                        'Enterprise Company Store Automation',
                        'Not sure yet',
                    ],
                ],
                'service' => ['label' => 'Service', 'max' => 120],
                'intent' => ['label' => 'Intent', 'max' => 120],
                'storeCount' => ['label' => 'Store count', 'max' => 80, 'choices' => ['None yet', '1-5', '6-25', '25+']],
                'notes' => ['label' => 'Notes', 'type' => 'textarea', 'max' => 2400],
                'selectedDate' => ['label' => 'Selected date', 'required' => true, 'max' => 120],
                'selectedDateISO' => ['label' => 'Selected date ISO', 'max' => 20],
                'selectedTime' => ['label' => 'Selected time', 'required' => true, 'max' => 120],
                'timezone' => ['label' => 'Timezone', 'max' => 120],
                'page' => ['label' => 'Page', 'type' => 'url', 'max' => 500],
                'form_loaded_at' => ['label' => 'Form loaded at', 'max' => 40],
            ];
        }

        return [
            'form_source' => ['label' => 'Form source', 'required' => true, 'max' => 80],
            'name' => ['label' => 'Name', 'required' => true, 'max' => 160],
            'email' => ['label' => 'Work email', 'type' => 'email', 'required' => true, 'max' => 254],
            'project_type' => [
                'label' => 'Project type',
                'required' => true,
                'max' => 160,
                'choices' => [
                    'Ecommerce technology',
                    'Business automation',
                    'System integration',
                    'SaaS platform',
                    'AI-enabled workflow',
                    'Internal business platform',
                    'Not sure yet',
                ],
            ],
            'stage' => [
                'label' => 'Stage',
                'required' => true,
                'max' => 160,
                'choices' => [
                    'Idea only',
                    'Existing manual workflow',
                    'Requirements already prepared',
                    'Prototype or MVP exists',
                    'Existing platform needs improvement',
                ],
            ],
            'problem' => ['label' => 'Problem', 'type' => 'textarea', 'required' => true, 'max' => 3000],
            'integrations' => ['label' => 'Integrations', 'max' => 160, 'choices' => ['Not sure yet', 'Yes', 'No']],
            'budget' => ['label' => 'Estimated investment', 'max' => 160],
            'page' => ['label' => 'Page', 'type' => 'url', 'max' => 500],
            'form_loaded_at' => ['label' => 'Form loaded at', 'max' => 40],
        ];
    }

    private static function save_submission(string $source, array $fields)
    {
        $name = self::field_value($fields, $source === 'book-demo' || $source === 'contact' ? 'fullName' : 'name');
        $email = self::field_value($fields, $source === 'book-demo' || $source === 'contact' ? 'workEmail' : 'email');
        $company = self::field_value($fields, 'companyName');
        $title_parts = array_filter([
            self::source_label($source),
            $company,
            $name,
        ]);

        $post_id = wp_insert_post([
            'post_type' => self::POST_TYPE,
            'post_status' => 'private',
            'post_title' => implode(' - ', $title_parts) ?: 'Website Form Submission',
        ], true);

        if (is_wp_error($post_id)) {
            return $post_id;
        }

        update_post_meta($post_id, 'astro_form_source', $source);
        update_post_meta($post_id, 'astro_form_name', $name);
        update_post_meta($post_id, 'astro_form_email', $email);
        update_post_meta($post_id, 'astro_form_company', $company);
        update_post_meta($post_id, 'astro_form_payload', $fields);
        update_post_meta($post_id, 'astro_form_ip', self::request_ip());
        update_post_meta($post_id, 'astro_form_user_agent', self::clean_text($_SERVER['HTTP_USER_AGENT'] ?? '', 500));

        foreach ($fields as $key => $field) {
            update_post_meta($post_id, 'astro_form_field_' . sanitize_key((string) $key), (string) ($field['value'] ?? ''));
        }

        return $post_id;
    }

    private static function send_admin_email(int $post_id, string $source, array $fields): bool
    {
        $admin_email = get_option('admin_email');
        if (!is_email($admin_email)) {
            error_log('Swishtag Astro Form: WordPress admin email is invalid.');
            return false;
        }

        $email = self::field_value($fields, $source === 'book-demo' || $source === 'contact' ? 'workEmail' : 'email');
        $name = self::field_value($fields, $source === 'book-demo' || $source === 'contact' ? 'fullName' : 'name');
        $subject = $source === 'book-demo'
            ? 'New book demo request - ' . (self::field_value($fields, 'companyName') ?: 'Swishtag website')
            : ($source === 'contact'
                ? 'New contact inquiry - ' . (self::field_value($fields, 'companyName') ?: ($name ?: 'Swishtag website'))
                : 'New custom software idea - ' . ($name ?: 'Swishtag website'));

        $lines = [
            'A new Swishtag website form submission was received.',
            '',
            'View it in WordPress:',
            admin_url('post.php?post=' . $post_id . '&action=edit'),
            '',
        ];

        foreach ($fields as $field) {
            $lines[] = (string) ($field['label'] ?? 'Field') . ': ' . ((string) ($field['value'] ?? '') ?: '-');
        }

        $headers = ['Content-Type: text/plain; charset=UTF-8'];
        if (is_email($email)) {
            $reply_name = $name !== '' ? $name : $email;
            $headers[] = 'Reply-To: ' . $reply_name . ' <' . $email . '>';
        }

        $sent = wp_mail($admin_email, $subject, implode("\n", $lines), $headers);
        if (!$sent) {
            error_log('Swishtag Astro Form: wp_mail failed for submission ' . $post_id . '.');
        }

        return (bool) $sent;
    }

    private static function json_response(bool $ok, string $message, int $status): WP_REST_Response
    {
        return new WP_REST_Response([
            'ok' => $ok,
            'message' => $message,
        ], $status);
    }

    private static function source_label(string $source): string
    {
        if ($source === 'book-demo') {
            return 'Book a Demo';
        }

        if ($source === 'custom-software') {
            return 'Custom Software & Automation';
        }

        if ($source === 'contact') {
            return 'Contact';
        }

        return $source;
    }

    private static function field_value(array $fields, string $key): string
    {
        return isset($fields[$key]['value']) ? (string) $fields[$key]['value'] : '';
    }

    private static function clean_text($value, int $max): string
    {
        $value = is_scalar($value) ? (string) $value : '';
        $value = str_replace(["\r", "\0"], '', $value);
        $value = sanitize_text_field($value);
        return self::limit($value, $max);
    }

    private static function clean_textarea($value, int $max): string
    {
        $value = is_scalar($value) ? (string) $value : '';
        $value = str_replace("\0", '', $value);
        $value = sanitize_textarea_field($value);
        return self::limit($value, $max);
    }

    private static function clean_email($value): string
    {
        $value = is_scalar($value) ? (string) $value : '';
        return self::limit(sanitize_email($value), 254);
    }

    private static function normalize_url(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }

        if (preg_match('/\s/', $value)) {
            return '';
        }

        if (!preg_match('/^[a-z][a-z0-9+.-]*:\/\//i', $value)) {
            $value = 'https://' . $value;
        }

        $url = esc_url_raw($value, ['http', 'https']);
        if ($url === '') {
            return '';
        }

        $host = wp_parse_url($url, PHP_URL_HOST);
        if (!is_string($host) || $host === '' || strpos($host, '.') === false) {
            return '';
        }

        return $url;
    }

    private static function limit(string $value, int $max): string
    {
        $value = trim($value);
        if (function_exists('mb_substr')) {
            return mb_substr($value, 0, $max);
        }

        return substr($value, 0, $max);
    }

    private static function request_ip(): string
    {
        $ip = $_SERVER['REMOTE_ADDR'] ?? '';
        return self::clean_text($ip, 80);
    }
}

add_action('plugins_loaded', ['Swishtag_Astro_Form_Submissions', 'init']);
register_activation_hook(__FILE__, ['Swishtag_Astro_Form_Submissions', 'activate']);
register_deactivation_hook(__FILE__, ['Swishtag_Astro_Form_Submissions', 'deactivate']);
